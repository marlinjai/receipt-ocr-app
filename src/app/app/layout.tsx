import { getCloudflareContext } from '@opennextjs/cloudflare';
import { D1Adapter } from '@marlinjai/data-table-adapter-d1';
import { setAdapter } from '@/lib/receipts-table';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.DB) {
      setAdapter(new D1Adapter(env.DB));
    }
  } catch {
    // Not running on Cloudflare — memory adapter will be used
  }

  return <>{children}</>;
}
