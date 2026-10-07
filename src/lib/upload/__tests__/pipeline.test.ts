import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { isSha256Hex, sha256Hex } from '../hash';
import { runUploadPipeline, type PipelineDeps, type PipelinePhase } from '../pipeline';
import { SplitPdfError, splitPdfPages } from '../split-pdf';

const OCR = { fullText: 'Testlokal 12,50', blocks: [], confidence: 0.9 };

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hash: vi.fn(async () => {
      calls.push('hash');
      return 'a'.repeat(64);
    }),
    checkDuplicate: vi.fn(async () => {
      calls.push('check');
      return null;
    }),
    upload: vi.fn(async (_f, onProgress) => {
      calls.push('upload');
      onProgress(100);
      return { id: 'file-1', originalName: 'beleg.jpg', fileType: 'image/jpeg' };
    }),
    recognize: vi.fn(async () => {
      calls.push('ocr');
      return OCR;
    }),
    save: vi.fn(async () => {
      calls.push('save');
      return { rowId: 'row-1', possibleDuplicateOf: null };
    }),
    ...overrides,
  };
}

const file = new File([new Uint8Array([1, 2, 3])], 'beleg.jpg', { type: 'image/jpeg' });

describe('runUploadPipeline', () => {
  it('forward: hash, check, upload, recognize, save, in that order, and the hash reaches the save', async () => {
    const d = deps();
    const phases: PipelinePhase[] = [];
    const outcome = await runUploadPipeline(file, d, { onPhase: (p) => phases.push(p) });
    expect(outcome).toEqual({ kind: 'done', rowId: 'row-1', similar: null });
    expect(d.calls).toEqual(['hash', 'check', 'upload', 'ocr', 'save']);
    expect(phases).toEqual(['checking', 'uploading', 'ocr', 'saving']);
    expect(d.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), OCR, { sha256: 'a'.repeat(64) });
  });

  it('the same file again: reported as a duplicate and NOTHING is uploaded', async () => {
    const d = deps({ checkDuplicate: vi.fn(async () => ({ rowId: 'row-0', name: 'Mittagessen Testlokal' })) });
    const outcome = await runUploadPipeline(file, d);
    expect(outcome).toEqual({ kind: 'duplicate', existing: { rowId: 'row-0', name: 'Mittagessen Testlokal' } });
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.recognize).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it('"upload anyway" skips the check and uploads', async () => {
    const check = vi.fn(async () => ({ rowId: 'row-0', name: 'x' }));
    const d = deps({ checkDuplicate: check });
    const outcome = await runUploadPipeline(file, d, { allowDuplicate: true });
    expect(outcome.kind).toBe('done');
    expect(check).not.toHaveBeenCalled();
  });

  it('the same receipt photographed twice: saved, with the similar receipt handed back for a warning', async () => {
    const d = deps({
      save: vi.fn(async () => ({ rowId: 'row-2', possibleDuplicateOf: { rowId: 'row-1', name: 'Testlokal' } })),
    });
    expect(await runUploadPipeline(file, d)).toEqual({
      kind: 'done',
      rowId: 'row-2',
      similar: { rowId: 'row-1', name: 'Testlokal' },
    });
  });

  it('a failing duplicate check stops before the upload (an unknown is not a "no")', async () => {
    const d = deps({
      checkDuplicate: vi.fn(async () => {
        throw new Error('check failed');
      }),
    });
    await expect(runUploadPipeline(file, d)).rejects.toThrow('check failed');
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('an error in any later step surfaces, it is not swallowed', async () => {
    const d = deps({
      recognize: vi.fn(async () => {
        throw new Error('OCR failed (502)');
      }),
    });
    await expect(runUploadPipeline(file, d)).rejects.toThrow('OCR failed (502)');
    expect(d.save).not.toHaveBeenCalled();
  });
});

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex, equal for equal content and different otherwise', async () => {
    const a = await sha256Hex(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await sha256Hex(new Blob([new Uint8Array([1, 2, 3])]));
    const c = await sha256Hex(new Blob([new Uint8Array([1, 2, 4])]));
    expect(a).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(isSha256Hex(a)).toBe(true);
  });
  it.each(['', 'abc', 'A'.repeat(64), 'g'.repeat(64), null, 42])('rejects %j as a hash', (v) => {
    expect(isSha256Hex(v)).toBe(false);
  });
});

async function pdfFile(pages: number, name = 'scan-2025.pdf'): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 300 + i]);
  return new File([(await doc.save()) as BlobPart], name, { type: 'application/pdf' });
}

describe('splitPdfPages', () => {
  it('splits a scan into one single-page PDF per page, in order, with numbered names', async () => {
    const pages = await splitPdfPages(await pdfFile(12));
    expect(pages).toHaveLength(12);
    expect(pages[0].name).toBe('scan-2025-seite-01.pdf');
    expect(pages[11].name).toBe('scan-2025-seite-12.pdf');
    expect(pages.every((p) => p.type === 'application/pdf')).toBe(true);
    for (const [i, page] of pages.entries()) {
      const doc = await PDFDocument.load(await page.arrayBuffer());
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getPage(0).getSize().height).toBe(300 + i);
    }
  });

  it('every page gets its own content hash', async () => {
    const pages = await splitPdfPages(await pdfFile(3));
    const hashes = await Promise.all(pages.map((p) => sha256Hex(p)));
    expect(new Set(hashes).size).toBe(3);
  });

  it('returns a one-page PDF unchanged', async () => {
    const single = await pdfFile(1);
    expect(await splitPdfPages(single)).toEqual([single]);
  });

  it('reports an unreadable file instead of uploading garbage', async () => {
    const broken = new File([new Uint8Array([1, 2, 3, 4])], 'kaputt.pdf', { type: 'application/pdf' });
    await expect(splitPdfPages(broken)).rejects.toBeInstanceOf(SplitPdfError);
    await expect(splitPdfPages(broken)).rejects.toMatchObject({ code: 'unreadable' });
  });
});
