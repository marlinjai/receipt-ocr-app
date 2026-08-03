import { describe, it, expect } from 'vitest';
import { parseCellUrl } from '../../../scripts/migrate-receipt-image-to-file-column.mjs';

describe('migration parseCellUrl', () => {
  const id = '3aad467f-7819-4d09-8f11-3071273e91e9';
  it('parses bare and /thumbnail forms', () => {
    expect(parseCellUrl(`/api/files/${id}`)).toEqual({ fileId: id, wasPdfThumb: false });
    expect(parseCellUrl(`/api/files/${id}/thumbnail`)).toEqual({ fileId: id, wasPdfThumb: true });
  });
  it('rejects foreign URLs, junk, and non-strings', () => {
    expect(parseCellUrl('https://elsewhere.example/x.pdf')).toBeNull();
    expect(parseCellUrl('/api/files/not-a-uuid')).toBeNull();
    expect(parseCellUrl('')).toBeNull();
    expect(parseCellUrl(null)).toBeNull();
    expect(parseCellUrl(42)).toBeNull();
  });
});
