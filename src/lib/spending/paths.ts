/**
 * Links into the spending page, as notifications carry them. They name the
 * company the message is about (`firma`): a tap on a phone opens the app in
 * whatever company was active last, and the page then offers to switch.
 */
export function spendingPath(workspaceId: string, query: Record<string, string> = {}, hash = ''): string {
  const params = new URLSearchParams({ ...query, firma: workspaceId });
  return `/app/spending?${params.toString()}${hash ? `#${hash}` : ''}`;
}
