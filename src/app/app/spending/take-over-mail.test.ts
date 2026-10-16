import { describe, expect, it, vi } from 'vitest';
import type { PipelineDeps, PipelineOutcome } from '@/lib/upload/pipeline';
import { takeOverMail, takeOverMessage } from './take-over-mail';

const pipeline = {} as PipelineDeps;
const pdf = (headers: Record<string, string> = {}) =>
  new Response(new Blob(['%PDF-1.4']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf", ...headers } });

describe('takeOverMail', () => {
  it('fetches the attachment and runs the normal upload pipeline with it', async () => {
    const run = vi.fn(async (): Promise<PipelineOutcome> => ({ kind: 'done', rowId: 'r1', similar: null, category: null, isMeal: false, attention: null, ocrError: null, elsewhere: [] }));
    const fetchImpl = vi.fn(async () => pdf());
    expect(await takeOverMail('c1', { fetchImpl: fetchImpl as unknown as typeof fetch, pipeline, run })).toEqual({ kind: 'done', rowId: 'r1' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/spending/mail-attachment/c1', { cache: 'no-store' });
    const [file, deps] = run.mock.calls[0] as unknown as [File, PipelineDeps];
    expect(file.name).toBe('Rechnung März.pdf');
    expect(file.type).toBe('application/pdf');
    expect(deps).toBe(pipeline);
  });

  it('reports an existing copy without uploading again', async () => {
    const run = vi.fn(async (): Promise<PipelineOutcome> => ({ kind: 'duplicate', existing: { rowId: 'r0', name: 'x' } }));
    expect(await takeOverMail('c1', { fetchImpl: (async () => pdf()) as unknown as typeof fetch, pipeline, run })).toEqual({ kind: 'duplicate', rowId: 'r0' });
  });

  it.each([
    [404, { error: 'not_found' }, 'not_found'],
    [503, { error: 'not_configured' }, 'mailbox_off'],
    [502, { error: 'auth_failed' }, 'mailbox_auth'],
    [502, { error: 'unavailable' }, 'mailbox_unavailable'],
    [413, { error: 'too_large' }, 'too_large'],
    [403, { error: 'forbidden' }, 'forbidden'],
  ])('turns an answer %s into %s', async (status, body, reason) => {
    const fetchImpl = async () => new Response(JSON.stringify(body), { status });
    expect(await takeOverMail('c1', { fetchImpl: fetchImpl as unknown as typeof fetch, pipeline })).toMatchObject({ kind: 'failed', reason });
  });

  it('reports no connection and a failed upload', async () => {
    const offline = async () => {
      throw new Error('offline');
    };
    expect(await takeOverMail('c1', { fetchImpl: offline as unknown as typeof fetch, pipeline })).toEqual({ kind: 'failed', reason: 'network' });
    const run = vi.fn(async () => {
      throw new Error('Upload failed with status 500');
    });
    expect(await takeOverMail('c1', { fetchImpl: (async () => pdf()) as unknown as typeof fetch, pipeline, run })).toEqual({ kind: 'failed', reason: 'upload', detail: 'Upload failed with status 500' });
  });
});

describe('takeOverMessage', () => {
  it('says what happened and what to do', () => {
    expect(takeOverMessage({ kind: 'done', rowId: 'r' }, true)).toBe('Als Beleg übernommen und mit der Zahlung verknüpft.');
    expect(takeOverMessage({ kind: 'done', rowId: 'r' }, false)).toMatch(/noch nicht mit der Zahlung verknüpft/);
    expect(takeOverMessage({ kind: 'duplicate', rowId: 'r' }, true)).toMatch(/jetzt mit der Zahlung verknüpft/);
    expect(takeOverMessage({ kind: 'failed', reason: 'too_large' })).toMatch(/zu groß/);
    expect(takeOverMessage({ kind: 'failed', reason: 'mailbox_auth' })).toMatch(/neu erteilt/);
    expect(takeOverMessage({ kind: 'failed', reason: 'not_found' })).toMatch(/nicht mehr im Postfach/);
  });
});
