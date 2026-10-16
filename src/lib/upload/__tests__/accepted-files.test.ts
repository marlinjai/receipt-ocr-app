import { describe, expect, it } from 'vitest';
import { isAcceptedUpload, withUploadType } from '../accepted-files';
import { validateReceiptFile } from '@/lib/presigned-file-adapter';

const file = (name: string, type: string) => new File(['<Invoice/>'], name, { type });

describe('isAcceptedUpload', () => {
  it('takes images, PDF and XML e-invoices', () => {
    for (const f of [file('a.jpg', 'image/jpeg'), file('b.heic', 'image/heic'), file('c.pdf', 'application/pdf'), file('d.xml', 'application/xml'), file('e.xml', 'text/xml'), file('f.XML', '')]) {
      expect(isAcceptedUpload(f)).toBe(true);
    }
  });

  it('refuses everything else, also a typeless file without an XML name', () => {
    for (const f of [file('a.txt', 'text/plain'), file('b.json', 'application/json'), file('c', ''), file('d.zip', 'application/zip')]) {
      expect(isAcceptedUpload(f)).toBe(false);
    }
  });
});

describe('withUploadType', () => {
  it('sends an XML file without a type, or with the generic one, as application/xml', () => {
    expect(withUploadType(file('r.xml', '')).type).toBe('application/xml');
    expect(withUploadType(file('r.xml', 'application/octet-stream')).type).toBe('application/xml');
    expect(withUploadType(file('r.xml', '')).name).toBe('r.xml');
  });

  it('leaves every other file as it is', () => {
    const typed = file('r.xml', 'text/xml');
    expect(withUploadType(typed)).toBe(typed);
    const pdf = file('scan.pdf', 'application/pdf');
    expect(withUploadType(pdf)).toBe(pdf);
  });
});

describe('validateReceiptFile (attaching by hand)', () => {
  it('takes an XML e-invoice, typed or recognised by its name', () => {
    expect(validateReceiptFile(file('r.xml', 'application/xml'))).toBeNull();
    expect(validateReceiptFile(file('r.xml', 'text/xml'))).toBeNull();
    expect(validateReceiptFile(file('r.xml', ''))).toBeNull();
  });

  it('still refuses other types', () => {
    expect(validateReceiptFile(file('r.txt', 'text/plain'))).toMatch(/Only PDF, PNG, JPEG or XML/);
  });
});
