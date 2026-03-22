import { D1Adapter } from '@marlinjai/data-table-adapter-d1';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { setAdapter } from '@/lib/receipts-table';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { env } = await getCloudflareContext();
  setAdapter(new D1Adapter(env.DB));

  return <>{children}</>;
}
