import { describe, it, expect } from 'vitest';
import { receiptImageUrl, repairedImageUrl } from './image-url';

describe('receiptImageUrl', () => {
  it('uses the /thumbnail form for PDFs (matches the upload flow)', () => {
    expect(receiptImageUrl('abc-123', 'invoice.pdf')).toBe('/api/files/abc-123/thumbnail');
    expect(receiptImageUrl('abc-123', 'INVOICE.PDF')).toBe('/api/files/abc-123/thumbnail');
  });
  it('uses the bare form for raster images', () => {
    expect(receiptImageUrl('abc-123', 'scan.png')).toBe('/api/files/abc-123');
    expect(receiptImageUrl('abc-123', 'photo.jpg')).toBe('/api/files/abc-123');
  });
});

describe('repairedImageUrl', () => {
  it('upgrades a bare PDF URL written by the pre-fix attach', () => {
    expect(repairedImageUrl('/api/files/3aad467f-7819-4d09', 'rechnung.pdf')).toBe(
      '/api/files/3aad467f-7819-4d09/thumbnail',
    );
  });
  it('leaves correct, non-PDF, and foreign values alone', () => {
    expect(repairedImageUrl('/api/files/x/thumbnail', 'rechnung.pdf')).toBeNull();
    expect(repairedImageUrl('/api/files/x', 'scan.png')).toBeNull();
    expect(repairedImageUrl('https://elsewhere.example/file.pdf', 'file.pdf')).toBeNull();
    expect(repairedImageUrl('', 'file.pdf')).toBeNull();
  });
});
