import { initializeReceiptsTable } from './actions';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await initializeReceiptsTable();
  return <>{children}</>;
}
