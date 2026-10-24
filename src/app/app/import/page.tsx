import { auth } from '@/lib/auth';
import ImportClient from './ImportClient';

export const dynamic = 'force-dynamic';

export default async function ImportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Middleware gates /app/*; requireSession resolves (or redirects) so the
  // client only ever renders for a verified workspace member.
  await auth.requireSession('/app/import');
  // Returning from the Google consent screen (?google=connected|error): read here, so the page renders with
  // the outcome instead of setting it in an effect after the first paint.
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  const google = first(params.google);
  return <ImportClient googleReturn={google ? { google, reason: first(params.reason) } : null} />;
}
