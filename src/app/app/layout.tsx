import { DataBrainAdapter } from '@/lib/data-brain-adapter';
import { setAdapter } from '@/lib/receipts-table';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Always use Data Brain as the single source of truth for all environments
  const apiKey = process.env.NEXT_PUBLIC_DATA_BRAIN_API_KEY;
  const baseUrl = process.env.NEXT_PUBLIC_DATA_BRAIN_URL;
  if (apiKey && baseUrl) {
    setAdapter(new DataBrainAdapter({ apiKey, baseUrl }));
  }

  return <>{children}</>;
}
