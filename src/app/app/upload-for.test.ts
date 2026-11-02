import { describe, expect, it } from 'vitest';
import { afterSave, checksHref, paymentLine, paymentToLink, refusalText, type UploadFor, type UploadForProgress } from './upload-for';
import { uploadForHref } from '@/lib/spending/paths';

const OPEN: UploadFor = { state: 'open', workspaceId: 'w1', payment: { id: 'p1', counterparty: 'Zyx Mobilität', bookingDay: '2026-11-01', amountCents: 427, estimated: false } };
const WAITING: UploadForProgress = { step: 'waiting' };

describe('an upload page opened for one payment', () => {
  it('forward: the first save asks for the link, and a linked answer moves the page on', () => {
    expect(paymentToLink(OPEN, WAITING)).toBe('p1');
    expect(afterSave(OPEN, WAITING, { paymentId: 'p1', linked: true })).toEqual({ step: 'linked' });
  });

  it('re-entry: once linked (or refused), later saves of the same page ask for no link and change nothing', () => {
    for (const done of [{ step: 'linked' }, { step: 'refused', reason: 'failed' }] as UploadForProgress[]) {
      expect(paymentToLink(OPEN, done)).toBeUndefined();
      expect(afterSave(OPEN, done, { paymentId: 'p1', linked: true })).toBe(done);
    }
  });

  it('a refusal keeps its reason, said in the person\'s words', () => {
    expect(afterSave(OPEN, WAITING, { paymentId: 'p1', linked: false, reason: 'already_has_receipt' })).toEqual({ step: 'refused', reason: 'already_has_receipt' });
    expect(refusalText('already_has_receipt')).toBe('die Zahlung hat inzwischen einen anderen Beleg');
    expect(refusalText('forbidden')).toBe('du darfst in dieser Firma keine Belege zuordnen');
  });

  it('a save that answered nothing about this payment leaves the page waiting', () => {
    expect(afterSave(OPEN, WAITING, undefined)).toBe(WAITING);
    expect(afterSave(OPEN, WAITING, null)).toBe(WAITING);
    expect(afterSave(OPEN, WAITING, { paymentId: 'p2', linked: true })).toBe(WAITING);
  });

  it('a payment that no longer waits, or no payment at all, is never linked', () => {
    const gone: UploadFor = { state: 'gone', workspaceId: 'w1' };
    expect(paymentToLink(gone, WAITING)).toBeUndefined();
    expect(paymentToLink(null, WAITING)).toBeUndefined();
    expect(afterSave(gone, WAITING, { paymentId: 'p1', linked: true })).toBe(WAITING);
  });

  it('names the payment as the card does, and leads back to the open receipts of its company', () => {
    expect(paymentLine(OPEN.state === 'open' ? OPEN.payment : (null as never))).toBe('Zyx Mobilität, 4,27 € vom 01.11.2026');
    expect(paymentLine({ id: 'p', counterparty: '', bookingDay: '2026-11-01', amountCents: 1000, estimated: true })).toBe('Zahlung ohne Namen, ca. 10,00 € vom 01.11.2026');
    expect(checksHref(OPEN)).toBe('/app/spending?ansicht=belege&firma=w1');
  });

  it('the card opens the upload page with the payment in the address', () => {
    expect(uploadForHref('p 1/2')).toBe('/app?fuer=p+1%2F2');
  });
});
