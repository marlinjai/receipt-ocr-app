/**
 * The call that fetches a company's issued documents from framer-clone's Books
 * (`GET /api/machine/books/documents`, framer-clone src/server/books/machine.ts),
 * every page, with the company API key in the Authorization header. Returns the
 * company the key belongs to (as the Books verified it) and the raw documents,
 * which `applyBooksDocuments` parses (books-mirror.ts holds the contract).
 *
 * Every failure is a BooksPullError with a stable code, never a silent empty
 * list: a refused key, a company without the Books, the Books not answering, an
 * answer of the wrong shape, more pages than a pull may walk. The key is never
 * part of an error or a log line.
 */

export const BOOKS_DOCUMENTS_PATH = '/api/machine/books/documents';
/** Documents per page asked for (the Books allow at most 200). */
export const BOOKS_PAGE_SIZE = 200;
/** A pull walks at most this many pages (40,000 documents); more is a fault, not a company. */
export const BOOKS_MAX_PAGES = 200;
/** Each request is cut after this long. */
export const BOOKS_REQUEST_TIMEOUT_MS = 30_000;

export type BooksPullErrorCode =
  /** The key was refused (unknown, revoked, expired, not a company key). */
  | 'books_key_refused'
  /** The key's company does not hold the Books (`books` grant), or the key is no workspace admin there. */
  | 'books_forbidden'
  /** The company has no Books set up. */
  | 'books_not_provisioned'
  /** The Books, or the sign-in service behind them, did not answer; the next pull tries again. */
  | 'books_unavailable'
  /** The Books answered something this app cannot read. */
  | 'books_bad_response'
  /** Two pages named different companies. */
  | 'books_company_changed'
  | 'books_too_many_pages';

export class BooksPullError extends Error {
  readonly code: BooksPullErrorCode;
  /** The HTTP status the Books answered, when they answered. */
  readonly status: number | null;
  constructor(code: BooksPullErrorCode, status: number | null = null) {
    super(`books pull failed: ${code}${status !== null ? ` (${status})` : ''}`);
    this.name = 'BooksPullError';
    this.code = code;
    this.status = status;
  }
}

export interface FetchedDocuments {
  companyId: string;
  documents: unknown[];
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; cache: 'no-store' }) => Promise<Response>;

function codeForStatus(status: number): BooksPullErrorCode {
  if (status === 401) return 'books_key_refused';
  if (status === 403) return 'books_forbidden';
  if (status === 404) return 'books_not_provisioned';
  if (status === 429 || status === 408 || status >= 500) return 'books_unavailable';
  return 'books_bad_response';
}

const isCompanyId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

export async function fetchIssuedDocuments(input: { baseUrl: string; key: string; fetch?: FetchLike }): Promise<FetchedDocuments> {
  const doFetch: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
  const documents: unknown[] = [];
  let companyId: string | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < BOOKS_MAX_PAGES; page += 1) {
    const url = new URL(BOOKS_DOCUMENTS_PATH, input.baseUrl);
    url.searchParams.set('limit', String(BOOKS_PAGE_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        headers: { authorization: `Bearer ${input.key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(BOOKS_REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      throw new BooksPullError('books_unavailable');
    }
    if (!res.ok) throw new BooksPullError(codeForStatus(res.status), res.status);
    let body: { companyId?: unknown; documents?: unknown; nextCursor?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new BooksPullError('books_bad_response', res.status);
    }
    if (!body || !isCompanyId(body.companyId) || !Array.isArray(body.documents) || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
      throw new BooksPullError('books_bad_response', res.status);
    }
    const pageCompany = body.companyId.toLowerCase();
    if (companyId !== null && pageCompany !== companyId) throw new BooksPullError('books_company_changed', res.status);
    companyId = pageCompany;
    documents.push(...body.documents);
    if (body.nextCursor === null) return { companyId, documents };
    if (body.nextCursor === cursor || body.nextCursor.length === 0) throw new BooksPullError('books_bad_response', res.status);
    cursor = body.nextCursor;
  }
  throw new BooksPullError('books_too_many_pages');
}
