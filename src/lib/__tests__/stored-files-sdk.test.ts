import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `deleteStoredFile` through the real `@marlinjai/storage-brain-sdk` client,
 * with only the network faked. In storage-brain-sdk 0.12 (unlike 0.9) its error classes
 * no longer extend `@marlinjai/brain-core/sdk`'s; this pins that the SDK still
 * turns the store's 404 into a `FileNotFoundError` the app recognises (an
 * already-deleted file counts as removed), and that any other refusal still
 * rejects so the caller keeps the receipt.
 */

const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function loadDelete() {
  vi.resetModules();
  return (await import('@/lib/stored-files')).deleteStoredFile;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('STORAGE_BRAIN_API_KEY', 'test-key-not-a-secret');
  vi.stubEnv('NEXT_PUBLIC_STORAGE_BRAIN_URL', 'https://storage.test');
  vi.stubEnv('NEXT_PUBLIC_STORAGE_BRAIN_WORKSPACE_ID', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('deleteStoredFile (real storage-brain-sdk client)', () => {
  it('sends an authenticated DELETE for the file and resolves', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true }));
    const deleteStoredFile = await loadDelete();

    await expect(deleteStoredFile('file-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://storage.test/api/v1/files/file-1');
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key-not-a-secret');
  });

  it('counts a file the store no longer has (404 FILE_NOT_FOUND) as removed', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'FILE_NOT_FOUND', message: 'gone', details: { fileId: 'file-2' } } }));
    const deleteStoredFile = await loadDelete();

    await expect(deleteStoredFile('file-2')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects any other refusal so the receipt is kept', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } }));
    const deleteStoredFile = await loadDelete();

    await expect(deleteStoredFile('file-3')).rejects.toThrow('bad key');
  });
});
