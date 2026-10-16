import { beforeEach, describe, expect, it, vi } from 'vitest';

const download = vi.fn();
const readStructured = vi.fn();
const prepare = vi.fn();
vi.mock('@/lib/stored-files', () => ({ downloadStoredFile: (...a: unknown[]) => download(...a) }));
vi.mock('@/lib/einvoice', () => ({ readStructuredInvoice: (...a: unknown[]) => readStructured(...a) }));
vi.mock('@/lib/receipt-page', () => ({ preparePage: (...a: unknown[]) => prepare(...a) }));

const { loadReceiptPage, loadReceiptSource } = await import('../receipt-page-source');

describe('loadReceiptSource: one download, the page only when asked for', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    download.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
    readStructured.mockReset().mockResolvedValue(null);
    prepare.mockReset().mockResolvedValue({ page: { mediaType: 'application/pdf', base64: 'AA==' } });
  });

  it('downloads once, prepares the page only when asked for, and gives the structured data', async () => {
    readStructured.mockResolvedValue({ source: { kind: 'xml' }, invoice: {}, xml: '<x/>' });
    const source = await loadReceiptSource('f1');
    expect(download).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(source.structured).not.toBeNull();
    expect((await source.page()).page).toBeDefined();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('a file that cannot be fetched: no page, no structured data, nothing thrown', async () => {
    download.mockRejectedValue(new Error('gone'));
    const source = await loadReceiptSource('f1');
    expect(source.structured).toBeNull();
    expect(await source.page()).toEqual({ skipped: 'missing' });
  });

  it('structured data that cannot be read: the page is read as before', async () => {
    readStructured.mockRejectedValue(new Error('broken xml'));
    const source = await loadReceiptSource('f1');
    expect(source.structured).toBeNull();
    expect((await source.page()).page).toBeDefined();
  });

  it('a page that cannot be prepared is a reading without it', async () => {
    prepare.mockRejectedValue(new Error('broken pdf'));
    expect(await loadReceiptPage('f1')).toEqual({ skipped: 'unreadable' });
  });
});
