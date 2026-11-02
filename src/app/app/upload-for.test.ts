import { describe, expect, it } from 'vitest';
import { afterDiscard, afterSave, checksHref, paymentLine, paymentToLink, refusalText, unlinkedText, type UploadFor, type UploadForProgress } from './upload-for';
import { uploadForHref } from '@/lib/spending/paths';

const OPEN: UploadFor = { state: 'open', workspaceId: 'w1', payment: { id: 'p1', counterparty: 'Zyx Mobilität', bookingDay: '2026-11-01', amountCents: 427, estimated: false } };
const WAITING: UploadForProgress = { step: 'waiting' };

describe('an upload page opened for one payment', () => {
  it('forward: the first save asks for the link, and a linked answer moves the page on', () => {
    expect(paymentToLink(OPEN, WAITING)).toBe('p1');
    expect(afterSave(OPEN, WAITING, { paymentId: 'p1', linked: true, rowId: 'r1' })).toEqual({ step: 'linked', rowId: 'r1', unlinked: 0 });
  });

  it('re-entry: once linked, later files ask for no link, and the same receipt answered again is still one link', () => {
    const linked: UploadForProgress = { step: 'linked', rowId: 'r1', unlinked: 0 };
    expect(paymentToLink(OPEN, linked)).toBeUndefined();
    expect(afterSave(OPEN, linked, { paymentId: 'p1', linked: true, rowId: 'r1' })).toBe(linked);
  });

  it('a further file of the same batch that could not be linked too is counted, so the page can say so', () => {
    const linked: UploadForProgress = { step: 'linked', rowId: 'r1', unlinked: 0 };
    const once = afterSave(OPEN, linked, { paymentId: 'p1', linked: false, reason: 'already_has_receipt' });
    expect(once).toEqual({ step: 'linked', rowId: 'r1', unlinked: 1 });
    expect(afterSave(OPEN, once, { paymentId: 'p1', linked: false, reason: 'already_has_receipt' })).toEqual({ step: 'linked', rowId: 'r1', unlinked: 2 });
    expect(unlinkedText(1)).toBe('1 weiterer Beleg dieses Uploads wurde gespeichert, aber keiner Zahlung zugeordnet.');
    expect(unlinkedText(2)).toBe('2 weitere Belege dieses Uploads wurden gespeichert, aber keiner Zahlung zugeordnet.');
  });

  it('a link wins over a refusal that arrived first (two files raced for the same payment)', () => {
    const refused: UploadForProgress = { step: 'refused', reason: 'already_has_receipt' };
    expect(afterSave(OPEN, refused, { paymentId: 'p1', linked: true, rowId: 'r2' })).toEqual({ step: 'linked', rowId: 'r2', unlinked: 0 });
    expect(afterSave(OPEN, refused, { paymentId: 'p1', linked: false, reason: 'failed' })).toBe(refused);
  });

  it('after a refusal no file asks again, except after a plain failure, which the next file may retry', () => {
    expect(paymentToLink(OPEN, { step: 'refused', reason: 'already_has_receipt' })).toBeUndefined();
    expect(paymentToLink(OPEN, { step: 'refused', reason: 'failed' })).toBe('p1');
  });

  it('backtrack: discarding the linked receipt opens the payment again; discarding another receipt does not', () => {
    const linked: UploadForProgress = { step: 'linked', rowId: 'r1', unlinked: 0 };
    expect(afterDiscard(linked, 'r1')).toEqual(WAITING);
    expect(afterDiscard(linked, 'r2')).toBe(linked);
    expect(afterDiscard(WAITING, 'r1')).toBe(WAITING);
    expect(paymentToLink(OPEN, afterDiscard(linked, 'r1'))).toBe('p1');
  });

  it('a refusal keeps its reason, said in the person\'s words', () => {
    expect(afterSave(OPEN, WAITING, { paymentId: 'p1', linked: false, reason: 'already_has_receipt' })).toEqual({ step: 'refused', reason: 'already_has_receipt' });
    expect(refusalText('already_has_receipt')).toBe('die Zahlung hat inzwischen einen anderen Beleg');
    expect(refusalText('forbidden')).toBe('du darfst in dieser Firma keine Belege zuordnen');
    expect(refusalText('receipt_not_found')).toBe('der Beleg ist nicht mehr da');
    expect(refusalText('receipt_already_paid')).toBe('der Beleg ist schon einer anderen Zahlung zugeordnet');
  });

  it('a save that answered nothing about this payment leaves the page waiting', () => {
    expect(afterSave(OPEN, WAITING, undefined)).toBe(WAITING);
    expect(afterSave(OPEN, WAITING, null)).toBe(WAITING);
    expect(afterSave(OPEN, WAITING, { paymentId: 'p2', linked: true, rowId: 'r2' })).toBe(WAITING);
  });

  it('a payment that no longer waits, or no payment at all, is never linked', () => {
    const gone: UploadFor = { state: 'gone', workspaceId: 'w1' };
    expect(paymentToLink(gone, WAITING)).toBeUndefined();
    expect(paymentToLink(null, WAITING)).toBeUndefined();
    expect(afterSave(gone, WAITING, { paymentId: 'p1', linked: true, rowId: 'r1' })).toBe(WAITING);
  });

  it('names the payment as the card does, and leads back to the open receipts of its company', () => {
    expect(paymentLine(OPEN.state === 'open' ? OPEN.payment : (null as never))).toBe('Zyx Mobilität, 4,27 € vom 01.11.2026');
    expect(paymentLine({ id: 'p', counterparty: '', bookingDay: '2026-11-01', amountCents: 1000, estimated: true })).toBe('Zahlung ohne Namen, ca. 10,00 € vom 01.11.2026');
    expect(checksHref(OPEN)).toBe('/app/spending?ansicht=belege&firma=w1');
  });

  it('the card opens the upload page with the payment in the address', () => {
    expect(uploadForHref('p 1/2', 'w1')).toBe('/app?fuer=p+1%2F2&firma=w1');
  });
});
