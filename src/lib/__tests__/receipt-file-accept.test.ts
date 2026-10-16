import { describe, expect, it } from 'vitest';
import { acceptAttribute, acceptedKindsLabel } from '../receipt-file-accept';
import { ACCEPTED_RECEIPT_TYPES } from '../presigned-file-adapter';

describe('receipt file picker', () => {
  it('names every media type and its extensions, each once', () => {
    expect(acceptAttribute(['application/pdf', 'image/png', 'image/jpeg'])).toBe('application/pdf,.pdf,image/png,.png,image/jpeg,.jpg,.jpeg');
    expect(acceptAttribute(['application/xml', 'text/xml'])).toBe('application/xml,.xml,text/xml');
  });

  it('keeps a type it does not know as the media type alone', () => {
    expect(acceptAttribute(['image/webp'])).toBe('image/webp');
  });

  it('the hint names each kind once, in order', () => {
    expect(acceptedKindsLabel(['application/pdf', 'image/png', 'image/jpeg'])).toBe('PDF, PNG or JPEG');
    expect(acceptedKindsLabel(['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/xml'])).toBe('PDF, PNG, JPEG or XML');
    expect(acceptedKindsLabel(['application/pdf'])).toBe('PDF');
    expect(acceptedKindsLabel(['application/pdf', 'image/png'], 'oder')).toBe('PDF oder PNG');
  });

  it('every type the upload accepts has its extensions, so no picker hides one', () => {
    for (const type of ACCEPTED_RECEIPT_TYPES) {
      expect(acceptAttribute([type]).split(',').length).toBeGreaterThan(1);
    }
  });
});
