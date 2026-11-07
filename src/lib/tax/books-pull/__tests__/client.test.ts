import { describe, expect, it, vi } from 'vitest';
import { BOOKS_MAX_PAGES, BooksPullError, fetchIssuedDocuments, type FetchLike } from '../client';
import { booksPullConfig, booksPullSecret } from '../config';

const COMPANY = '0190a000-0000-7000-8000-000000000001';
const KEY = 'test-key-built-at-run-time-' + Math.random().toString(36).slice(2);

const page = (documents: unknown[], nextCursor: string | null, companyId = COMPANY) =>
  new Response(JSON.stringify({ companyId, documents, nextCursor }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('fetchIssuedDocuments', () => {
  it('walks every page with the key in the header and returns the company and all documents', async () => {
    const calls: string[] = [];
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      calls.push(url);
      expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(init.cache).toBe('no-store');
      return new URL(url).searchParams.get('cursor') ? page([{ id: 'b' }], null) : page([{ id: 'a' }], 'c1');
    });
    const out = await fetchIssuedDocuments({ baseUrl: 'https://books.example', key: KEY, fetch });
    expect(out).toEqual({ companyId: COMPANY, documents: [{ id: 'a' }, { id: 'b' }] });
    expect(calls[0]).toBe('https://books.example/api/machine/books/documents?limit=200');
    expect(new URL(calls[1]).searchParams.get('cursor')).toBe('c1');
  });

  it.each([
    [401, 'books_key_refused'],
    [403, 'books_forbidden'],
    [404, 'books_not_provisioned'],
    [429, 'books_unavailable'],
    [503, 'books_unavailable'],
    [400, 'books_bad_response'],
  ])('turns an answer %i into %s, never an empty list', async (status, code) => {
    const fetch: FetchLike = async () => new Response('{}', { status });
    await expect(fetchIssuedDocuments({ baseUrl: 'https://books.example', key: KEY, fetch })).rejects.toMatchObject({ code, status });
  });

  it('says unavailable when the Books cannot be reached, and never puts the key in the error', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await fetchIssuedDocuments({ baseUrl: 'https://books.example', key: KEY, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BooksPullError);
    expect((err as BooksPullError).code).toBe('books_unavailable');
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('refuses an answer of the wrong shape, a company that changes between pages, a cursor that repeats', async () => {
    const bad: FetchLike = async () => new Response(JSON.stringify({ documents: 'no' }), { status: 200 });
    await expect(fetchIssuedDocuments({ baseUrl: 'https://b.example', key: KEY, fetch: bad })).rejects.toMatchObject({ code: 'books_bad_response' });
    const notJson: FetchLike = async () => new Response('<html>', { status: 200 });
    await expect(fetchIssuedDocuments({ baseUrl: 'https://b.example', key: KEY, fetch: notJson })).rejects.toMatchObject({ code: 'books_bad_response' });
    let n = 0;
    const switching: FetchLike = async () => (n++ === 0 ? page([], 'c1') : page([], null, '0190a000-0000-7000-8000-000000000002'));
    await expect(fetchIssuedDocuments({ baseUrl: 'https://b.example', key: KEY, fetch: switching })).rejects.toMatchObject({ code: 'books_company_changed' });
    const repeating: FetchLike = async () => page([], 'same');
    await expect(fetchIssuedDocuments({ baseUrl: 'https://b.example', key: KEY, fetch: repeating })).rejects.toMatchObject({ code: 'books_bad_response' });
  });

  it('stops after the page bound instead of walking forever', async () => {
    let n = 0;
    const endless: FetchLike = async () => page([], `c${n++}`);
    await expect(fetchIssuedDocuments({ baseUrl: 'https://b.example', key: KEY, fetch: endless })).rejects.toMatchObject({ code: 'books_too_many_pages' });
    expect(n).toBe(BOOKS_MAX_PAGES);
  });
});

describe('booksPullConfig', () => {
  it('needs the key, defaults the address, and refuses plain http outside localhost', () => {
    expect(booksPullConfig({})).toEqual({ configured: false, missing: ['BOOKS_PULL_KEY'] });
    expect(booksPullConfig({ BOOKS_PULL_KEY: 'PLACEHOLDER_REPLACE_ME' })).toEqual({ configured: false, missing: ['BOOKS_PULL_KEY'] });
    expect(booksPullSecret({ BOOKS_PULL_SECRET: 'PLACEHOLDER_REPLACE_ME' })).toBeUndefined();
    expect(booksPullConfig({ BOOKS_PULL_KEY: KEY })).toEqual({ configured: true, baseUrl: 'https://app.lumitra.co', key: KEY });
    expect(booksPullConfig({ BOOKS_PULL_KEY: KEY, BOOKS_URL: 'http://books.example' })).toEqual({ configured: false, missing: ['BOOKS_URL'] });
    expect(booksPullConfig({ BOOKS_PULL_KEY: KEY, BOOKS_URL: 'http://localhost:3001/x' })).toMatchObject({ configured: true, baseUrl: 'http://localhost:3001' });
  });
});
