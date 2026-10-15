import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  RenditionError,
  canRotate,
  inlineDisposition,
  jpegOrientation,
  renditionName,
  rotatedRendition,
  type Rendition,
} from '../rotated-rendition';
import { jpegFile, pageRotations, pageSizes, pdfFile, pngFile } from './fixtures';

const PORTRAIT = { width: 300, height: 800 };
const LANDSCAPE = { width: 800, height: 300 };

function pdfOf(r: Rendition): Uint8Array {
  if (r.kind !== 'pdf') throw new Error(`expected a turned PDF, got ${r.kind}`);
  return r.bytes;
}

describe('rotatedRendition: PDF', () => {
  it('a stored 0 serves the file as it is', async () => {
    const r = await rotatedRendition(await pdfFile([PORTRAIT]), 'application/pdf', 0);
    expect(r.kind).toBe('original');
  });

  it.each([90, 180, 270] as const)('a stored %i turns the page by exactly that', async (rotation) => {
    const r = await rotatedRendition(await pdfFile([PORTRAIT]), 'application/pdf', rotation);
    expect(r.rotation).toBe(rotation);
    expect(await pageRotations(pdfOf(r))).toEqual([rotation]);
  });

  it('adds to the rotation a page already carries, wrapping past 360', async () => {
    const own90 = await rotatedRendition(await pdfFile([{ ...PORTRAIT, ownRotation: 90 }]), 'application/pdf', 90);
    expect(await pageRotations(pdfOf(own90))).toEqual([180]);
    const own270 = await rotatedRendition(await pdfFile([{ ...PORTRAIT, ownRotation: 270 }]), 'application/pdf', 180);
    expect(await pageRotations(pdfOf(own270))).toEqual([90]);
  });

  it('turns every page of a multi-page PDF, each on top of its own rotation, and keeps their sizes', async () => {
    const source = await pdfFile([PORTRAIT, { ...LANDSCAPE, ownRotation: 90 }, { width: 400, height: 400, ownRotation: 180 }]);
    const turned = pdfOf(await rotatedRendition(source, 'application/pdf', 270));
    expect(await pageRotations(turned)).toEqual([270, 0, 90]);
    expect(await pageSizes(turned)).toEqual(await pageSizes(source));
  });

  it('without a stored rotation a wide first page is turned upright, as the viewer shows it', async () => {
    const r = await rotatedRendition(await pdfFile([LANDSCAPE, PORTRAIT]), 'application/pdf', null);
    expect(r.rotation).toBe(90);
    expect(await pageRotations(pdfOf(r))).toEqual([90, 90]);
  });

  it('the guess looks at the page as it is shown: a wide page that turns itself upright stays as it is', async () => {
    const r = await rotatedRendition(await pdfFile([{ ...LANDSCAPE, ownRotation: 90 }]), 'application/pdf', null);
    expect(r.kind).toBe('original');
  });

  it('a stored 0 beats the guess, also for a wide page', async () => {
    expect((await rotatedRendition(await pdfFile([LANDSCAPE]), 'application/pdf', 0)).kind).toBe('original');
  });

  it('a file that is no PDF is refused with a reason, never handed back unturned', async () => {
    const broken = new TextEncoder().encode('not a pdf at all');
    await expect(rotatedRendition(broken, 'application/pdf', 90)).rejects.toMatchObject({ code: 'unreadable_pdf' });
  });

  it('an encrypted PDF is refused with a reason', async () => {
    // A PDF whose trailer names an encryption dictionary, the way pdf-lib recognises one.
    const doc = await PDFDocument.load(await pdfFile([PORTRAIT]));
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
    const encrypted = await doc.save({ useObjectStreams: false });
    await expect(rotatedRendition(encrypted, 'application/pdf', 90)).rejects.toMatchObject({ code: 'encrypted_pdf' });
  });

  it('does not change the stored bytes it was given', async () => {
    const source = await pdfFile([PORTRAIT]);
    const copy = source.slice();
    await rotatedRendition(source, 'application/pdf', 90);
    expect(source).toEqual(copy);
  });
});

describe('rotatedRendition: images', () => {
  it.each([
    ['image/jpeg', () => jpegFile(300, 800)],
    ['image/png', () => pngFile(30, 80)],
  ] as const)('%s with a stored 0 is served as it is', async (type, make) => {
    expect((await rotatedRendition(make(), type, 0)).kind).toBe('original');
  });

  it.each([90, 180, 270] as const)('a JPEG stored at %i becomes a one-page PDF turned by that, picture unchanged', async (rotation) => {
    const r = await rotatedRendition(jpegFile(300, 800), 'image/jpeg', rotation);
    const pdf = pdfOf(r);
    expect(await pageRotations(pdf)).toEqual([rotation]);
    expect(await pageSizes(pdf)).toEqual([{ width: 300, height: 800 }]);
  });

  it.each([90, 180, 270] as const)('a PNG stored at %i becomes a one-page PDF turned by that', async (rotation) => {
    const pdf = pdfOf(await rotatedRendition(pngFile(30, 80), 'image/png', rotation));
    expect(await pageRotations(pdf)).toEqual([rotation]);
    expect(await pageSizes(pdf)).toEqual([{ width: 30, height: 80 }]);
  });

  it('a wide image without a stored rotation is turned upright, like in the viewer', async () => {
    const r = await rotatedRendition(pngFile(80, 30), 'image/png', null);
    expect(await pageRotations(pdfOf(r))).toEqual([90]);
  });

  it('a JPEG camera flag is applied too, since the browser and the viewer apply it', async () => {
    // Flag 6: the browser shows the picture turned by 90; the stored 90 comes on top.
    const r = await rotatedRendition(jpegFile(800, 300, 6), 'image/jpeg', 90);
    expect(await pageRotations(pdfOf(r))).toEqual([180]);
  });

  it('the guess looks at the picture as the browser shows it, flag included', async () => {
    // Stored wide, but flag 6 shows it tall: nothing to turn.
    expect((await rotatedRendition(jpegFile(800, 300, 6), 'image/jpeg', null)).kind).toBe('original');
  });

  it('a mirrored camera flag cannot be reproduced and is refused when a turn is needed', async () => {
    await expect(rotatedRendition(jpegFile(300, 800, 2), 'image/jpeg', 90)).rejects.toMatchObject({ code: 'mirrored_image' });
    // Without a turn the browser shows the file itself, mirror and all.
    expect((await rotatedRendition(jpegFile(300, 800, 2), 'image/jpeg', 0)).kind).toBe('original');
  });

  it('an image that cannot be read is refused with a reason', async () => {
    await expect(rotatedRendition(new Uint8Array([1, 2, 3]), 'image/png', 90)).rejects.toBeInstanceOf(RenditionError);
  });

  it('a type that cannot be turned is refused', async () => {
    await expect(rotatedRendition(new Uint8Array([1]), 'image/webp', 90)).rejects.toMatchObject({ code: 'unsupported_type' });
    expect(canRotate('image/webp')).toBe(false);
    expect(canRotate('Application/PDF; charset=binary')).toBe(true);
  });
});

describe('jpegOrientation', () => {
  it('reads the flag in both byte orders', () => {
    expect(jpegOrientation(jpegFile(10, 10, 8, true))).toBe(8);
    expect(jpegOrientation(jpegFile(10, 10, 3, false))).toBe(3);
  });

  it('is 1 without a flag, for broken data and for anything that is no JPEG', () => {
    expect(jpegOrientation(jpegFile(10, 10))).toBe(1);
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(1);
    expect(jpegOrientation(pngFile(2, 2))).toBe(1);
    expect(jpegOrientation(new Uint8Array(0))).toBe(1);
  });
});

describe('names for the turned copy', () => {
  const pdf: Rendition = { kind: 'pdf', bytes: new Uint8Array(), rotation: 90 };
  const original: Rendition = { kind: 'original', rotation: 0 };

  it('the stored file keeps its name; a turned copy says it is one, as a PDF', () => {
    expect(renditionName('foto.png', original)).toBe('foto.png');
    expect(renditionName('Kassenbon Bäckerei.jpg', pdf)).toBe('Kassenbon Bäckerei (gedreht).pdf');
    expect(renditionName('scan.PDF', pdf)).toBe('scan (gedreht).pdf');
    expect(renditionName('ohne-endung', pdf)).toBe('ohne-endung (gedreht).pdf');
  });

  it('removes path separators and control characters, and never ends up empty', () => {
    expect(renditionName('../a/b\\c\r\n.jpg', pdf)).toBe('.. a b c (gedreht).pdf');
    expect(renditionName('', original)).toBe('Beleg');
    expect(renditionName('.pdf', pdf)).toBe('Beleg (gedreht).pdf');
  });

  it('a long name is cut between characters, so an emoji at the cut never breaks the header', () => {
    const long = `${'a'.repeat(199)}😀😀.pdf`;
    const kept = renditionName(long, original);
    expect(Array.from(kept)).toHaveLength(200);
    expect(() => inlineDisposition(kept)).not.toThrow();
    const turned = renditionName(`${'b'.repeat(179)}😀😀.jpg`, pdf);
    expect(turned).toBe(`${'b'.repeat(179)}😀 (gedreht).pdf`);
    expect(() => inlineDisposition(turned)).not.toThrow();
  });

  it('the disposition shows the file inline and keeps umlauts for the download', () => {
    const value = inlineDisposition('Rechnung "Müller".pdf');
    expect(value.startsWith('inline; ')).toBe(true);
    expect(value).toContain(`filename="Rechnung _M_ller_.pdf"`);
    expect(value).toContain("filename*=UTF-8''Rechnung%20%22M%C3%BCller%22.pdf");
  });
});
