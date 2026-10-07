import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { isSha256Hex, sha256Hex } from '../hash';
import { runUploadPipeline, type PipelineDeps, type PipelinePhase } from '../pipeline';
import { PrepareImageError, needsConversion, prepareImage, targetSize, type ImageCodec } from '../prepare-image';
import { SplitPdfError, splitPdfPages } from '../split-pdf';

const OCR = { fullText: 'Testlokal 12,50', blocks: [], confidence: 0.9 };
const SAVED = { rowId: 'row-1', possibleDuplicateOf: null, category: 'Bewirtung', isMeal: true, attention: null };
const DONE = { kind: 'done', rowId: 'row-1', similar: null, category: 'Bewirtung', isMeal: true, attention: null, ocrError: null };

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prepare: vi.fn(async (f: File) => {
      calls.push('prepare');
      return f;
    }),
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
      return { ...SAVED, rowId: 'row-1' };
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
    expect(outcome).toEqual(DONE);
    expect(d.calls).toEqual(['prepare', 'hash', 'check', 'upload', 'ocr', 'save']);
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
      save: vi.fn(async () => ({ ...SAVED, rowId: 'row-2', possibleDuplicateOf: { rowId: 'row-1', name: 'Testlokal' } })),
    });
    expect(await runUploadPipeline(file, d)).toEqual({
      ...DONE,
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

  it('text recognition fails: the receipt is STILL saved (no orphaned file), flagged, with the reason', async () => {
    const save = vi.fn(async () => ({ ...SAVED, category: null, isMeal: false, attention: 'ocr_failed' as const }));
    const d = deps({
      recognize: vi.fn(async () => {
        throw new Error('OCR failed (502)');
      }),
      save,
    });
    const outcome = await runUploadPipeline(file, d);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), null, { sha256: 'a'.repeat(64) });
    expect(outcome).toEqual({ ...DONE, category: null, isMeal: false, attention: 'ocr_failed', ocrError: 'OCR failed (502)' });
  });

  it('an upload or save error surfaces, it is not swallowed', async () => {
    const failingUpload = deps({
      upload: vi.fn(async () => {
        throw new Error('Upload network error');
      }),
    });
    await expect(runUploadPipeline(file, failingUpload)).rejects.toThrow('Upload network error');
    expect(failingUpload.save).not.toHaveBeenCalled();
    const failingSave = deps({
      save: vi.fn(async () => {
        throw new Error('save failed');
      }),
    });
    await expect(runUploadPipeline(file, failingSave)).rejects.toThrow('save failed');
  });

  it('uploads and hashes the PREPARED file (the scaled photo), not the original', async () => {
    const scaled = new File([new Uint8Array([9])], 'beleg.jpg', { type: 'image/jpeg' });
    const d = deps({ prepare: vi.fn(async () => scaled) });
    await runUploadPipeline(file, d);
    expect(d.hash).toHaveBeenCalledWith(scaled);
    expect((d.upload as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(scaled);
  });

  it('a photo the browser cannot read stops before anything is uploaded', async () => {
    const d = deps({
      prepare: vi.fn(async () => {
        throw new PrepareImageError('undecodable');
      }),
    });
    await expect(runUploadPipeline(file, d)).rejects.toThrow(/cannot be read by the browser/);
    expect(d.upload).not.toHaveBeenCalled();
  });
});

describe('prepareImage', () => {
  const codec = (width: number, height: number, encoded: Blob | null = new Blob(['jpeg'])): ImageCodec & { released: number } => {
    const c = {
      released: 0,
      decode: vi.fn(async () => ({ width, height, source: 'bitmap', release: () => { c.released += 1; } })),
      encodeJpeg: vi.fn(async () => encoded),
    };
    return c;
  };
  const photo = (type: string, name = 'IMG_0001.HEIC') => new File([new Uint8Array(10)], name, { type });

  it('scales a large photo to 2000 pixels on the long edge, as JPEG, keeping the aspect ratio', async () => {
    const c = codec(4032, 3024);
    const out = await prepareImage(photo('image/jpeg', 'foto.jpeg'), c);
    expect(c.encodeJpeg).toHaveBeenCalledWith('bitmap', 2000, 1500, 0.85);
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('foto.jpg');
    expect(c.released).toBe(1);
  });

  it('converts a type the file column does not accept (HEIC, WebP) even when it is small', async () => {
    const c = codec(800, 600);
    const out = await prepareImage(photo('image/heic'), c);
    expect(c.encodeJpeg).toHaveBeenCalledWith('bitmap', 800, 600, 0.85);
    expect(out.name).toBe('IMG_0001.jpg');
  });

  it('leaves a small JPEG or PNG and any PDF untouched', async () => {
    const small = photo('image/png', 'scan.png');
    expect(await prepareImage(small, codec(1200, 900))).toBe(small);
    const pdf = new File([new Uint8Array(4)], 'scan.pdf', { type: 'application/pdf' });
    const c = codec(1, 1);
    expect(await prepareImage(pdf, c)).toBe(pdf);
    expect(c.decode).not.toHaveBeenCalled();
  });

  it('reports a photo that cannot be decoded or encoded', async () => {
    const undecodable: ImageCodec = { decode: async () => { throw new Error('unsupported'); }, encodeJpeg: async () => null };
    await expect(prepareImage(photo('image/heic'), undecodable)).rejects.toMatchObject({ code: 'undecodable' });
    await expect(prepareImage(photo('image/heic'), codec(100, 100, null))).rejects.toMatchObject({ code: 'encode_failed' });
  });

  it('targetSize never enlarges and handles portrait', () => {
    expect(targetSize(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(targetSize(3000, 6000)).toEqual({ width: 1000, height: 2000 });
    expect(needsConversion('image/jpeg', 2000, 1000)).toBe(false);
    expect(needsConversion('image/jpeg', 2001, 1000)).toBe(true);
    expect(needsConversion('image/webp', 10, 10)).toBe(true);
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
