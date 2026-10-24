/**
 * Links into the spending page, as notifications carry them. They name the
 * company the message is about (`firma`): a tap on a phone opens the app in
 * whatever company was active last, and the page then offers to switch.
 */
export function spendingPath(workspaceId: string, query: Record<string, string> = {}, hash = ''): string {
  const params = new URLSearchParams({ ...query, firma: workspaceId });
  return `/app/spending?${params.toString()}${hash ? `#${hash}` : ''}`;
}

/** The two tabs of the spending page; the name is what the address says (`ansicht`). */
export type SpendingTab = 'ueberblick' | 'belege';

/** The tab an address asks for: a notification about a payment (`pruefen`) opens the receipt checks, anything else the overview. */
export function spendingTabOf(ansicht: string | undefined, pruefen: string | undefined): SpendingTab {
  return ansicht === 'belege' || pruefen ? 'belege' : 'ueberblick';
}

/** The address of the spending page for a period and a tab: the overview is the default and is not named. */
export function spendingHref(year: number, month: number | null, tab: SpendingTab): string {
  const params = new URLSearchParams({ jahr: String(year) });
  if (month !== null) params.set('monat', String(month));
  if (tab === 'belege') params.set('ansicht', 'belege');
  return `/app/spending?${params.toString()}`;
}
