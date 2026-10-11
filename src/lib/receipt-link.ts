/**
 * The address that opens one receipt in the receipts table: the dashboard
 * reads the id and opens the receipt's panel once its rows are loaded. Used
 * wherever another area names a receipt (the finance lines, the open checks,
 * the payments), so a figure can be followed back to its document.
 */
export const RECEIPT_PARAM = 'beleg';

export function receiptHref(rowId: string): string {
  return `/app/dashboard?${RECEIPT_PARAM}=${encodeURIComponent(rowId)}`;
}
