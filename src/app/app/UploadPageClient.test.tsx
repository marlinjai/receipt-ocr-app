// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { UploadLink } from '@/lib/upload/pipeline';
import type { UploadFor } from './upload-for';

/**
 * The upload page opened for one payment, with its two uploaders replaced by
 * stand-ins that hand back what the page gave them. Pinned here: the banner
 * through every step, the company fixed to the payment's, where the page goes
 * after a batch, and that discarding the linked receipt opens the payment again.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams() }));
const deleteRow = vi.fn();
vi.mock('./dashboard/actions', () => ({ deleteRow: (...a: unknown[]) => deleteRow(...a) }));
vi.mock('./actions', () => ({ processReceipt: vi.fn(), retakeReceipt: vi.fn(), linkExistingUpload: vi.fn() }));

type UploaderProps = ComponentProps<typeof import('@/components/ReceiptUploader').default>;
type CaptureProps = ComponentProps<typeof import('@/components/capture/PhoneCapture').default>;
const seen: { uploader: UploaderProps | null; capture: CaptureProps | null } = { uploader: null, capture: null };
vi.mock('@/components/ReceiptUploader', () => ({
  default: (props: UploaderProps) => {
    seen.uploader = props;
    return null;
  },
}));
vi.mock('@/components/capture/PhoneCapture', () => ({
  default: (props: CaptureProps) => {
    seen.capture = props;
    return null;
  },
}));

import UploadPageClient from './UploadPageClient';

const TARGETS = [
  { workspaceId: 'w1', label: 'Firma Eins' },
  { workspaceId: 'w2', label: 'Firma Zwei' },
];
const OPEN: UploadFor = { state: 'open', workspaceId: 'w1', payment: { id: 'p1', counterparty: 'Zyx Mobilität', bookingDay: '2026-11-01', amountCents: 427, estimated: false } };
const LINKED: UploadLink = { paymentId: 'p1', linked: true, rowId: 'r1' };

function mount(uploadFor: UploadFor | null) {
  return render(<UploadPageClient targets={TARGETS} initialWorkspaceId="w1" uploadFor={uploadFor} />);
}

beforeEach(() => {
  push.mockReset();
  deleteRow.mockReset().mockResolvedValue(undefined);
  seen.uploader = null;
  seen.capture = null;
});
afterEach(cleanup);

describe('the upload page opened for a payment', () => {
  it('names the payment, fixes the company to its own, and hands the payment to both uploaders', () => {
    mount(OPEN);
    expect(screen.getByText('Beleg für Zyx Mobilität, 4,27 € vom 01.11.2026')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Firma Eins')).toBeTruthy();
    expect(seen.uploader?.forPayment?.paymentId).toBe('p1');
    expect(seen.capture?.forPaymentId).toBe('p1');
    expect(screen.getByRole('link', { name: 'Ohne Zuordnung hochladen' }).getAttribute('href')).toBe('/app');
  });

  it('forward: linked, it says so, files chosen from now on are for no payment, and the batch leads back to the open receipts', () => {
    mount(OPEN);
    act(() => seen.uploader!.onLinked!(LINKED));
    expect(screen.getByText(/Zugeordnet: der Beleg gehört jetzt zu Zyx Mobilität/)).toBeTruthy();
    expect(seen.uploader?.forPayment).toBeNull();
    expect(seen.capture?.forPaymentId).toBeNull();
    act(() => seen.uploader!.onAllComplete({ total: 1, succeeded: 1, failed: 0 }));
    expect(push).toHaveBeenCalledWith('/app/spending?ansicht=belege&firma=w1');
  });

  it('backtrack: discarding the linked receipt opens the payment again, and the next file is for it', async () => {
    mount(OPEN);
    act(() => seen.capture!.onLinked!(LINKED));
    await act(() => seen.capture!.onDiscardRow('r1'));
    expect(deleteRow).toHaveBeenCalledWith('r1');
    expect(screen.getByText('Beleg für Zyx Mobilität, 4,27 € vom 01.11.2026')).toBeTruthy();
    expect(seen.capture?.forPaymentId).toBe('p1');
  });

  it('a refusal stays on screen with its reason and the way to link by hand; the batch does not move on', () => {
    mount(OPEN);
    act(() => seen.uploader!.onLinked!({ paymentId: 'p1', linked: false, reason: 'already_has_receipt' }));
    expect(screen.getByRole('alert').textContent).toMatch(/gespeichert, aber nicht .* zugeordnet: die Zahlung hat inzwischen einen anderen Beleg/);
    act(() => seen.uploader!.onAllComplete({ total: 1, succeeded: 1, failed: 0 }));
    expect(push).not.toHaveBeenCalled();
  });

  it('an answer about another payment (a photo queued for it earlier) leaves the page waiting', () => {
    mount(OPEN);
    act(() => seen.capture!.onLinked!({ paymentId: 'p0', linked: true, rowId: 'r0' }));
    expect(screen.getByText('Beleg für Zyx Mobilität, 4,27 € vom 01.11.2026')).toBeTruthy();
    expect(seen.capture?.forPaymentId).toBe('p1');
  });

  it('a payment that no longer waits: said, nothing is linked, and the company may be chosen as usual', () => {
    mount({ state: 'gone', workspaceId: 'w1' });
    expect(screen.getByText(/Diese Zahlung wartet nicht mehr auf einen Beleg/)).toBeTruthy();
    expect(seen.uploader?.forPayment).toBeNull();
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('opened plainly: no banner, no payment, and a batch goes to the receipts as before', () => {
    mount(null);
    expect(screen.queryByRole('status')).toBeNull();
    expect(seen.uploader?.forPayment).toBeNull();
    act(() => seen.uploader!.onAllComplete({ total: 1, succeeded: 1, failed: 0 }));
    expect(push).toHaveBeenCalledWith('/app/dashboard');
  });
});
