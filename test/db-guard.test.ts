import { describe, expect, it } from 'vitest';
import { assertThrowawayUrl } from './db-guard';

describe('assertThrowawayUrl', () => {
  it('accepts a local database whose name ends in _test, on localhost or 127.0.0.1', () => {
    expect(assertThrowawayUrl('TEST_DATABASE_URL', 'postgresql://u:p@127.0.0.1:5432/receipts_test')).toEqual({
      url: 'postgresql://u:p@127.0.0.1:5432/receipts_test',
      database: 'receipts_test',
    });
    expect(assertThrowawayUrl('X', 'postgres://u@localhost/contacts_test?sslmode=disable').database).toBe('contacts_test');
  });

  it('refuses a database whose name does not end in _test', () => {
    for (const name of ['receipts', 'receipts_test_copy', 'test', 'receipts-test', 'my_test;drop']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', `postgresql://u@127.0.0.1/${name}`)).toThrow(/must name a database ending in "_test"/);
    }
    expect(() => assertThrowawayUrl('TEST_DATABASE_URL', 'postgresql://u@127.0.0.1/')).toThrow(/\(none\)/);
  });

  it('refuses a host that is not this machine, whatever the database is called', () => {
    for (const host of ['db.example.com', '10.0.0.5', 'receipts-postgres', '127.0.0.2', '100.124.97.31']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', `postgresql://u@${host}:5432/receipts_test`)).toThrow(/must point at a database on this machine/);
    }
  });

  it('refuses every query parameter that could change the server, database, user or schema', () => {
    for (const param of ['host=db.example.com', 'hostaddr=10.0.0.5', 'service=prod', 'HOST=db.example.com', 'database=receipts', 'user=postgres', 'options=-c%20search_path%3Dx', 'schema=other', 'dbname=receipts']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', `postgresql://u@localhost/receipts_test?${param}`)).toThrow(/must not carry/);
    }
    expect(assertThrowawayUrl('X', 'postgresql://u@localhost/receipts_test?sslmode=disable&connect_timeout=5').database).toBe('receipts_test');
  });

  it('refuses a URL that clients read differently: several hosts, or more than one "user@" part', () => {
    // postgres.js reads the first as the hosts prod.example.com and "x@localhost"; the URL standard reads host localhost.
    for (const url of ['postgresql://u@prod.example.com,x@localhost/receipts_test', 'postgresql://u@localhost,prod.example.com/receipts_test', 'postgresql://a@b@localhost/receipts_test']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', url)).toThrow(/exactly one host/);
    }
  });

  it('hands back a URL rebuilt from the parts it checked, with the password and allowed parameters kept', () => {
    expect(assertThrowawayUrl('X', 'postgres://dev:s%40cret@127.0.0.1:5497/receipts_test?sslmode=disable').url).toBe(
      'postgresql://dev:s%40cret@127.0.0.1:5497/receipts_test?sslmode=disable',
    );
  });

  it('refuses other loopback spellings, which fails safe', () => {
    for (const host of ['[::1]', '127.1', 'LOCALHOST.']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', `postgresql://u@${host}/receipts_test`)).toThrow(/written "localhost" or "127.0.0.1"/);
    }
  });

  it('refuses a missing or malformed URL and other protocols, naming the variable', () => {
    expect(() => assertThrowawayUrl('CONTACTS_TEST_DATABASE_URL', undefined)).toThrow(/CONTACTS_TEST_DATABASE_URL is not set/);
    expect(() => assertThrowawayUrl('TEST_DATABASE_URL', 'not a url')).toThrow(/not a valid database URL/);
    expect(() => assertThrowawayUrl('TEST_DATABASE_URL', 'mysql://u@localhost/receipts_test')).toThrow(/postgres:\/\/ URL/);
  });
});
