import { auth } from '@/lib/auth';
import ImportClient from './ImportClient';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  // Middleware gates /app/*; requireSession resolves (or redirects) so the
  // client only ever renders for a verified workspace member.
  await auth.requireSession('/app/import');
  return <ImportClient />;
}
