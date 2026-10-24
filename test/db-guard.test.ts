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

  it('refuses query parameters that could send the connection to another server', () => {
    for (const param of ['host=db.example.com', 'hostaddr=10.0.0.5', 'service=prod', 'HOST=db.example.com']) {
      expect(() => assertThrowawayUrl('TEST_DATABASE_URL', `postgresql://u@localhost/receipts_test?${param}`)).toThrow(/could send the connection/);
    }
  });

  it('refuses a missing or malformed URL and other protocols, naming the variable', () => {
    expect(() => assertThrowawayUrl('CONTACTS_TEST_DATABASE_URL', undefined)).toThrow(/CONTACTS_TEST_DATABASE_URL is not set/);
    expect(() => assertThrowawayUrl('TEST_DATABASE_URL', 'not a url')).toThrow(/not a valid database URL/);
    expect(() => assertThrowawayUrl('TEST_DATABASE_URL', 'mysql://u@localhost/receipts_test')).toThrow(/postgres:\/\/ URL/);
  });
});
