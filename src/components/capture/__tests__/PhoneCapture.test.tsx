// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newQueuedCapture, type CaptureStore, type QueuedCapture } from '@/lib/capture/offline-queue';
import { UploadStepError } from '@/lib/upload/errors';
import type { PipelineDeps, SavedReceipt } from '@/lib/upload/pipeline';

/**
 * The capture screen with the network replaced: `createBrowserDeps` hands back
 * controllable steps, and the queue is an in-memory store behind the same
 * interface. (The IndexedDB store itself is tested in offline-queue.test.ts;
 * under jsdom a File does not survive the test database's structured clone.)
 */

function memoryStore(): CaptureStore {
  let entries: QueuedCapture[] = [];
  return {
    async add(entry) {
      entries = [...entries.filter((e) => e.id !== entry.id), entry];
    },
    async list() {
      return [...entries].sort((a, b) => a.addedAt - b.addedAt);
    },
    async remove(id) {
      entries = entries.filter((e) => e.id !== id);
    },
    async update(id, patch) {
      entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    },
  };
}

const steps = {
  checkDuplicate: vi.fn(),
  upload: vi.fn(),
  recognize: vi.fn(),
};
vi.mock('@/lib/upload/browser-deps', () => ({
  // Like the real one: the company travels with the check and the save.
  createBrowserDeps: (save: (f: unknown, o: unknown, opts: { sha256: string; workspaceId: string }) => Promise<SavedReceipt>, workspaceId: string): PipelineDeps => ({
    prepare: async (f) => f,
    hash: async () => 'a'.repeat(64),
    checkDuplicate: (sha256) => steps.checkDuplicate(sha256, workspaceId),
    upload: (...a) => steps.upload(...a),
    recognize: (...a) => steps.recognize(...a),
    save: (file, ocr, options) => save(file, ocr, { ...options, workspaceId }),
  }),
}));
vi.mock('@/components/meals/MealPanelSection', () => ({
  default: ({ rowId, secondaryAction }: { rowId: string; secondaryAction?: { label: string; onClick: () => void } }) => (
    <div>
      <p>Bewirtungsformular für {rowId}</p>
      {secondaryAction && <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
    </div>
  ),
}));

import PhoneCapture from '../PhoneCapture';

const MEAL: SavedReceipt = { rowId: 'row-1', possibleDuplicateOf: null, category: 'Bewirtung', isMeal: true, attention: null };
const OTHER: SavedReceipt = { rowId: 'row-2', possibleDuplicateOf: null, category: 'Bürobedarf', isMeal: false, attention: null };

let store: CaptureStore;
let online = true;
const onSave = vi.fn();
const retakeSave = vi.fn();
const onRetake = vi.fn(() => retakeSave);
const onDiscardRow = vi.fn();

function photo(name = 'foto.jpg') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

const NO_COPY = { existing: null, elsewhere: [] };

function mount(workspaceId = 'ws-eins') {
  const utils = render(<PhoneCapture workspaceId={workspaceId} onSave={onSave} onRetake={onRetake} onDiscardRow={onDiscardRow} store={store} />);
  const inputs = utils.container.querySelectorAll('input[type="file"]');
  return { ...utils, camera: inputs[0] as HTMLInputElement, retake: inputs[1] as HTMLInputElement, user: userEvent.setup() };
}

function take(input: HTMLInputElement, file = photo()) {
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  store = memoryStore();
  online = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  for (const fn of [steps.checkDuplicate, steps.upload, steps.recognize, onSave, retakeSave, onRetake, onDiscardRow]) fn.mockReset();
  onRetake.mockImplementation(() => retakeSave);
  steps.checkDuplicate.mockResolvedValue(NO_COPY);
  steps.upload.mockResolvedValue({ id: 'file-1', originalName: 'foto.jpg', fileType: 'image/jpeg' });
  steps.recognize.mockResolvedValue({ fullText: 'Testlokal 12,50', blocks: [], confidence: 0.9 });
  onSave.mockResolvedValue(MEAL);
});
afterEach(cleanup);

describe('forward', () => {
  it('uses the rear camera, one photo at a time', () => {
    const { camera } = mount();
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.getAttribute('accept')).toBe('image/*');
    expect(camera.multiple).toBe(false);
  });

  it('a business meal: saved, then the meal details are asked right away; "Später" leaves it for the queue', async () => {
    const { camera, user } = mount();
    take(camera);
    expect(await screen.findByText('Bewirtungsformular für row-1')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/Eingeordnet als: Bewirtung/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Später' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Still reachable from the result.
    expect(screen.getByRole('button', { name: 'Teilnehmer und Anlass eintragen' })).toBeTruthy();
  });

  it('any other receipt: a short confirmation with the category and "next photo", no sheet', async () => {
    onSave.mockResolvedValue(OTHER);
    const { camera } = mount();
    take(camera);
    expect(await screen.findByText(/Eingeordnet als: Bürobedarf/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Nächstes Foto' })).toBeTruthy();
  });
});

describe('blurry photo and failed recognition: retake on the SAME receipt', () => {
  it('a blurry photo offers a retake that replaces the photo on the same row, never a second row', async () => {
    onSave.mockResolvedValue({ ...MEAL, attention: 'low_quality' });
    retakeSave.mockResolvedValue(MEAL);
    const { camera, retake } = mount();
    take(camera);
    expect(await screen.findByText(/schwer lesbar/)).toBeTruthy();
    // No meal sheet for a receipt that was not read properly.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Neu aufnehmen' })).toBeTruthy();

    take(retake, photo('scharf.jpg'));
    expect(await screen.findByText(/Foto ersetzt und neu gelesen/)).toBeTruthy();
    expect(onRetake).toHaveBeenCalledWith('row-1');
    expect(retakeSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1); // the first capture only: no second row
    // Now well read: the meal details follow.
    expect(await screen.findByText('Bewirtungsformular für row-1')).toBeTruthy();
  });

  it('text recognition fails: the receipt is saved anyway and the reason is shown', async () => {
    steps.recognize.mockRejectedValue(new UploadStepError('server', 'OCR failed (502)'));
    onSave.mockResolvedValue({ ...OTHER, category: null, attention: 'ocr_failed' });
    const { camera } = mount();
    take(camera);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/gespeichert, konnte aber nicht gelesen werden/);
    expect(alert.textContent).toMatch(/Die Texterkennung ist fehlgeschlagen \(Fehler 502\)/);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), null, { sha256: 'a'.repeat(64), workspaceId: 'ws-eins' });
  });
});

describe('duplicates', () => {
  it('the same photo again: nothing is uploaded; "upload anyway" is explicit', async () => {
    steps.checkDuplicate.mockResolvedValueOnce({ existing: { rowId: 'row-0', name: 'Mittagessen Testlokal' }, elsewhere: [] });
    const { camera, user } = mount();
    take(camera);
    expect(await screen.findByText(/schon beim Beleg „Mittagessen Testlokal“ hinterlegt/)).toBeTruthy();
    expect(steps.upload).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Trotzdem hochladen' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('the same receipt photographed twice: warned, and "discard" deletes the new row', async () => {
    onSave.mockResolvedValue({ ...OTHER, possibleDuplicateOf: { rowId: 'row-0', name: 'Druckerpapier' } });
    onDiscardRow.mockResolvedValue(undefined);
    const { camera, user } = mount();
    take(camera);
    expect(await screen.findByText(/sieht nach einem Beleg aus, den es schon gibt/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Neuen verwerfen' }));
    await waitFor(() => expect(onDiscardRow).toHaveBeenCalledWith('row-2'));
    expect(await screen.findByText(/Der neue Beleg wurde verworfen/)).toBeTruthy();
  });

  it('the same file in another company: saved where the page says, warned with that company, and can be discarded here', async () => {
    steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: ['Firma Zwei'] });
    onDiscardRow.mockResolvedValue(undefined);
    const { camera, user } = mount();
    take(camera);
    expect(await screen.findByText(/Genau diese Datei liegt schon in deiner Firma Firma Zwei/)).toBeTruthy();
    expect(onSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ workspaceId: 'ws-eins' }));
    // The meal sheet waits: first the question whether this receipt belongs here at all.
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Hier verwerfen' }));
    await waitFor(() => expect(onDiscardRow).toHaveBeenCalledWith('row-1'));
  });

  it('"keep here" dismisses the warning and the receipt stays', async () => {
    steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: ['Firma Zwei'] });
    onSave.mockResolvedValue(OTHER);
    const { camera, user } = mount();
    take(camera);
    await screen.findByText(/Genau diese Datei liegt schon/);
    await user.click(screen.getByRole('button', { name: 'Hier behalten' }));
    expect(screen.queryByText(/Genau diese Datei liegt schon/)).toBeNull();
    expect(onDiscardRow).not.toHaveBeenCalled();
  });
});

describe('the company a photo goes into', () => {
  it('a photo is checked and saved in the company the page names, not in another', async () => {
    onSave.mockResolvedValue(OTHER);
    const { camera } = mount('ws-zwei');
    take(camera);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(steps.checkDuplicate).toHaveBeenCalledWith('a'.repeat(64), 'ws-zwei');
    expect(onSave.mock.calls[0][2]).toMatchObject({ workspaceId: 'ws-zwei' });
  });

  it('a photo queued offline keeps its company: changing the page\'s company before it is sent does not move it', async () => {
    online = false;
    onSave.mockResolvedValue(OTHER);
    const { camera, rerender } = mount('ws-eins');
    take(camera, photo('eins.jpg'));
    await screen.findByText('1 Foto wartet auf den Versand.');
    expect((await store.list())[0].workspaceId).toBe('ws-eins');

    rerender(<PhoneCapture workspaceId="ws-zwei" onSave={onSave} onRetake={onRetake} onDiscardRow={onDiscardRow} store={store} />);
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(await screen.findByText(/1 wartendes Foto wurde gesendet/)).toBeTruthy();
    expect(onSave.mock.calls[0][2]).toMatchObject({ workspaceId: 'ws-eins' });
  });

  it('resume: a photo from an earlier visit goes to its own company; one without (shared into the app) to the page\'s', async () => {
    onSave.mockResolvedValue(OTHER);
    await store.add(newQueuedCapture(photo('von-gestern.jpg'), 'camera', 1, 'ws-eins'));
    await store.add(newQueuedCapture(photo('geteilt.jpg'), 'share', 2));
    mount('ws-zwei');
    expect(await screen.findByText(/2 wartende Fotos wurden gesendet/)).toBeTruthy();
    expect(onSave.mock.calls.map((c) => c[2].workspaceId)).toEqual(['ws-eins', 'ws-zwei']);
  });

  it('re-entry after an expired session: the queued photo still goes to the company it was taken for', async () => {
    steps.checkDuplicate.mockRejectedValueOnce(new UploadStepError('auth', 'Your session has expired.'));
    onSave.mockResolvedValue(OTHER);
    const first = mount('ws-eins');
    take(first.camera);
    await screen.findByText(/Die Anmeldung ist abgelaufen/);
    first.unmount();
    // Signed in again, the page opens on another company.
    mount('ws-zwei');
    expect(await screen.findByText(/1 wartendes Foto wurde gesendet/)).toBeTruthy();
    expect(onSave.mock.calls[0][2]).toMatchObject({ workspaceId: 'ws-eins' });
  });

  it('a queued photo found in another company is still sent, and the note says where else it is', async () => {
    onSave.mockResolvedValue(OTHER);
    steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: ['Firma Zwei'] });
    await store.add(newQueuedCapture(photo('von-gestern.jpg'), 'camera', 1, 'ws-eins'));
    mount('ws-eins');
    expect(await screen.findByText(/liegt genau so schon in deiner Firma Firma Zwei/)).toBeTruthy();
  });
});

describe('offline, lost connection, expired session', () => {
  it('offline: the photo goes into the queue, is counted, and nothing is attempted', async () => {
    online = false;
    const { camera } = mount();
    take(camera);
    expect(await screen.findByText(/Keine Verbindung. Das Foto ist auf diesem Gerät gespeichert/)).toBeTruthy();
    expect(await screen.findByText('1 Foto wartet auf den Versand.')).toBeTruthy();
    expect(steps.upload).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it('when the connection returns the queue is sent once and the count clears', async () => {
    online = false;
    const { camera } = mount();
    take(camera, photo('eins.jpg'));
    await screen.findByText('1 Foto wartet auf den Versand.');
    take(camera, photo('zwei.jpg'));
    await screen.findByText('2 Fotos warten auf den Versand.');

    online = true;
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online')); // twice: still one run
    expect(await screen.findByText(/2 wartende Fotos wurden gesendet/)).toBeTruthy();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/warten auf den Versand/)).toBeNull();
    expect(await store.list()).toEqual([]);
    // Meals captured offline are pointed to the queue of open meals.
    expect(screen.getByRole('link', { name: 'Zu den offenen Bewirtungen' })).toBeTruthy();
  });

  it('a connection lost mid-upload: the photo is kept in the queue instead of being lost', async () => {
    steps.upload.mockRejectedValue(new UploadStepError('network', 'Upload network error'));
    const { camera } = mount();
    take(camera);
    expect(await screen.findByText('1 Foto wartet auf den Versand.')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('an expired session: the photo is kept and the way back in is offered', async () => {
    steps.checkDuplicate.mockRejectedValue(new UploadStepError('auth', 'Your session has expired.'));
    const { camera } = mount();
    take(camera);
    expect(await screen.findByText(/Die Anmeldung ist abgelaufen. Das Foto ist auf diesem Gerät gespeichert/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Neu anmelden' }).getAttribute('href')).toBe('/app');
    expect(await store.list()).toHaveLength(1);
  });

  it('photos waiting from an earlier visit are shown and sent when the page opens (resume)', async () => {
    await store.add(newQueuedCapture(photo('von-gestern.jpg'), 'camera', 1));
    mount();
    expect(await screen.findByText(/1 wartendes Foto wurde gesendet/)).toBeTruthy();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
  });

  it('a queued photo that fails for another reason stays, with its error and a retry', async () => {
    await store.add(newQueuedCapture(photo('kaputt.jpg'), 'camera', 1));
    steps.upload.mockRejectedValue(new UploadStepError('server', 'Upload request failed'));
    const { user } = mount();
    expect(await screen.findByText(/kaputt.jpg: Der Upload wurde vom Server abgelehnt/)).toBeTruthy();
    expect(screen.getByText('1 Foto wartet auf den Versand.')).toBeTruthy();
    steps.upload.mockResolvedValue({ id: 'file-9', originalName: 'kaputt.jpg', fileType: 'image/jpeg' });
    await user.click(screen.getByRole('button', { name: 'Jetzt senden' }));
    expect(await screen.findByText(/1 wartendes Foto wurde gesendet/)).toBeTruthy();
  });

  it('a photo that was sent but cannot be removed from the queue is not sent again and not shown as waiting', async () => {
    await store.add(newQueuedCapture(photo('fest.jpg'), 'camera', 1));
    const remove = store.remove;
    store.remove = vi.fn().mockRejectedValue(new Error('QuotaExceededError'));
    const { user } = mount();
    expect(await screen.findByText(/1 gesendetes Foto konnte nicht aus der Warteschlange entfernt werden/)).toBeTruthy();
    expect(await screen.findByText(/fest.jpg: Bereits gesendet, konnte aber nicht aus der Warteschlange entfernt werden/)).toBeTruthy();
    expect(screen.queryByText(/wartet auf den Versand/)).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(1);
    // A second trigger (the connection returning) must not upload it again.
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(store.remove).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenCalledTimes(1);
    // The user can still drop the entry by hand once the browser allows it.
    store.remove = remove;
    await user.click(screen.getByRole('button', { name: 'fest.jpg aus der Warteschlange entfernen' }));
    // The dialog says what is true for this entry: the receipt is saved, only the entry goes.
    expect(screen.getByRole('dialog').textContent).toMatch(/bereits gesendet und ist als Beleg gespeichert/);
    expect(screen.getByRole('dialog').textContent).not.toMatch(/noch nicht gesendet/);
    await user.click(screen.getByRole('button', { name: 'Entfernen' }));
    await waitFor(async () => expect(await store.list()).toEqual([]));
  });
});

describe('a photo that keeps failing', () => {
  it('can be removed from the queue, after an in-page confirmation', async () => {
    await store.add(newQueuedCapture(photo('kaputt.jpg'), 'camera', 1));
    steps.upload.mockRejectedValue(new UploadStepError('server', 'Upload request failed'));
    const { user } = mount();
    await screen.findByText(/kaputt.jpg: Der Upload wurde vom Server abgelehnt/);
    await user.click(screen.getByRole('button', { name: 'kaputt.jpg aus der Warteschlange entfernen' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/noch nicht gesendet/);
    // Cancelling keeps it.
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(await store.list()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'kaputt.jpg aus der Warteschlange entfernen' }));
    await user.click(screen.getByRole('button', { name: 'Entfernen' }));
    await waitFor(async () => expect(await store.list()).toEqual([]));
    expect(screen.queryByText(/wartet auf den Versand/)).toBeNull();
  });
});

describe('other failures', () => {
  it('a server error shows the reason, says no receipt was created, and retries the same photo', async () => {
    steps.upload.mockRejectedValueOnce(new UploadStepError('server', 'Upload request failed'));
    const { camera, user } = mount();
    take(camera);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Der Upload wurde vom Server abgelehnt/);
    expect(alert.textContent).toMatch(/Es wurde kein Beleg angelegt/);
    await user.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('Bewirtungsformular für row-1')).toBeTruthy();
    expect(steps.upload).toHaveBeenCalledTimes(2);
  });
});

describe('wording', () => {
  it('known upload failures are shown in German, unknown ones as they are', async () => {
    const { captureErrorText } = await import('@/lib/capture/messages');
    expect(captureErrorText('This image format cannot be read by the browser. Take the photo again or save it as JPEG.')).toMatch(/Bildformat/);
    expect(captureErrorText('Upload network error')).toBe('Keine Verbindung zum Server.');
    expect(captureErrorText('Upload failed with status 413')).toMatch(/Fehler 413/);
    expect(captureErrorText('Etwas ganz anderes')).toBe('Etwas ganz anderes');
    expect(captureErrorText(null)).toBe('Das Foto konnte nicht verarbeitet werden.');
  });
});
