/** Setup for `pnpm check:copy`: a local copy of production, never anything else. */
const url = process.env.COPY_DATABASE_URL;
if (!url) throw new Error('COPY_DATABASE_URL is not set: point it at a restored backup on this machine.');
const host = new URL(url).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`COPY_DATABASE_URL must point at a local database, got host "${host}".`);
process.env.DATABASE_URL = url;
export {};
