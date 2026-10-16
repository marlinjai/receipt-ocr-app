import { auth } from '@/lib/auth';
import { listClassificationRules } from '../rules-actions';
import RulesClient from './RulesClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Zuordnungsregeln' };

export default async function RulesPage() {
  await auth.requireSession('/app/rules');
  const loaded = await listClassificationRules();
  return <RulesClient initial={loaded.ok ? loaded.value : null} />;
}
