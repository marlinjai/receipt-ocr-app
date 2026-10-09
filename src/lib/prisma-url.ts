/**
 * The data-table adapter keeps each table's rows in a real Postgres table and
 * adds or drops a column of it while the app is running. Postgres refuses to
 * run a prepared `SELECT *` again once the table's shape has changed ("cached
 * plan must not change result type"), and Prisma keeps prepared statements per
 * connection. With the cache on, every connection that had read a row of the
 * table failed on it from then on: the adapter reports that as "Row not found",
 * so saves were refused until the process restarted.
 *
 * With the cache off a statement is planned for the table as it is now. The
 * price is planning each query again, which this app does not notice.
 */
export function withoutStatementCache(url: string | undefined): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: leave it for Prisma to reject with its own message.
    return url;
  }
  parsed.searchParams.set('statement_cache_size', '0');
  return parsed.toString();
}
