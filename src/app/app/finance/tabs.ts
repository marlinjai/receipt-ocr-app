import type { StatementView } from '@/lib/tax/service';

/**
 * The groups and tabs of the Finanzen page (plan
 * docs/plans/2026-10-25-finance-groups.md): four groups in a row on top, the
 * tabs of the chosen group below. Pure, so the page, the server page and the
 * tests read one table.
 *
 * The address keeps the tab (`?reiter=`), never the group: the group follows
 * from the tab. Values from before the groups keep working, so a link in a
 * notification or a bookmark still lands in the right place.
 */

export type GroupKey = 'todo' | 'review' | 'taxes' | 'settings';

export type TabKey =
  | 'open'
  | 'questions'
  | 'statement'
  | 'revenue'
  | 'payments'
  | 'assets'
  | 'vat'
  | 'tax'
  | 'accounts'
  | 'vendors'
  | 'names';

export interface TabDef {
  key: TabKey;
  label: string;
  /** The value of `?reiter=` for this tab. */
  address: string;
}

export interface GroupDef {
  key: GroupKey;
  label: string;
  /** Also accepted as `?reiter=`: opens the group on its first tab. */
  address: string;
  tabs: readonly TabDef[];
}

export const GROUPS: readonly GroupDef[] = [
  {
    key: 'todo',
    label: 'Erledigen',
    address: 'erledigen',
    tabs: [
      { key: 'open', label: 'Offen', address: 'offen' },
      { key: 'questions', label: 'Zahlungen klären', address: 'zahlungen-klaeren' },
    ],
  },
  {
    key: 'review',
    label: 'Auswerten',
    address: 'auswerten',
    tabs: [
      { key: 'statement', label: 'EÜR', address: 'euer' },
      { key: 'revenue', label: 'Einnahmen', address: 'einnahmen' },
      { key: 'payments', label: 'Zahlungen', address: 'zahlungsliste' },
      { key: 'assets', label: 'Anlagen', address: 'anlagen' },
    ],
  },
  {
    key: 'taxes',
    label: 'Steuer',
    address: 'steuer',
    tabs: [
      { key: 'vat', label: 'Umsatzsteuer', address: 'umsatzsteuer' },
      { key: 'tax', label: 'Einkommensteuer', address: 'einkommensteuer' },
    ],
  },
  {
    key: 'settings',
    label: 'Einstellungen',
    address: 'einstellungen',
    tabs: [
      { key: 'accounts', label: 'Konten', address: 'konten' },
      { key: 'vendors', label: 'Lieferanten', address: 'lieferanten' },
      { key: 'names', label: 'Eigene Namen', address: 'eigene-namen' },
    ],
  },
];

/**
 * Values of `?reiter=` from before the groups. `zahlungen` was the one tab of
 * all payments; what waited there (and what its count counted) are now the
 * questions under Erledigen.
 */
const LEGACY: Readonly<Record<string, TabKey>> = { zahlungen: 'questions' };

const BY_TAB = new Map(GROUPS.flatMap((g) => g.tabs.map((t) => [t.key, { group: g, tab: t }] as const)));

export function groupOf(tab: TabKey): GroupDef {
  return BY_TAB.get(tab)!.group;
}

export function addressOf(tab: TabKey): string {
  return BY_TAB.get(tab)!.tab.address;
}

/**
 * The tab an address opens; undefined when it names none (the page then
 * chooses by what waits). The return from the bank (`bank` present) always
 * opens the accounts, whatever `reiter` says: older returns still carry
 * `reiter=zahlungen`, and the outcome is shown with the accounts.
 */
export function tabFromAddress(reiter: string | null | undefined, bank = false): TabKey | undefined {
  if (bank) return 'accounts';
  if (typeof reiter !== 'string') return undefined;
  const value = reiter.trim().toLowerCase();
  if (LEGACY[value]) return LEGACY[value];
  for (const group of GROUPS) {
    if (group.address === value) return group.tabs[0].key;
    const tab = group.tabs.find((t) => t.address === value);
    if (tab) return tab.key;
  }
  return undefined;
}

/** What waits on the tabs that hold work: the items to decide with the overdue invoices, and the payment questions. */
export function waitingCounts(view: StatementView, queueLength: number): Partial<Record<TabKey, number>> {
  return {
    open: queueLength + view.revenue.overdue.length,
    questions: view.payments.open.length + view.payments.unclassified.length,
  };
}

/** The sum of what waits in a group; undefined for a group that holds no work. */
export function groupCount(group: GroupDef, counts: Partial<Record<TabKey, number>>): number | undefined {
  const parts = group.tabs.map((t) => counts[t.key]).filter((n): n is number => n !== undefined);
  return parts.length === 0 ? undefined : parts.reduce((s, n) => s + n, 0);
}

/** The tab a page opens on without an address: the first work that waits, else the statement. */
export function defaultTab(counts: Partial<Record<TabKey, number>>): TabKey {
  if ((counts.open ?? 0) > 0) return 'open';
  if ((counts.questions ?? 0) > 0) return 'questions';
  return 'statement';
}
