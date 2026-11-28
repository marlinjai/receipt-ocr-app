import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The web app manifest, read as the browser reads it. Installability was confirmed in Chrome on
 * 2026-11-27 (`Page.getInstallabilityErrors` empty); these checks keep what Chrome alone does not
 * insist on: PNG icons for the platforms that take no SVG, an `id` that keeps installed copies the
 * same app, and the share target the service worker answers.
 */
const PUBLIC = join(__dirname, '../../../../public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')) as {
  id: string;
  name: string;
  short_name: string;
  lang: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  shortcuts: Array<{ name: string; url: string }>;
  share_target: { action: string; method: string; params: { files: Array<{ name: string }> } };
};

/** Width and height from a PNG's header. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('public/manifest.json', () => {
  it('keeps the id installed copies already have (Chrome derived "/app" from the start address)', () => {
    expect(manifest.id).toBe('/app');
    expect(manifest.start_url).toBe('/app');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('names the app as it is called, in the language of its pages', () => {
    expect(manifest.name).toBe('Lumitra Receipts');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.lang).toBe('de');
  });

  it('has PNG icons of 192 and 512 px and a maskable one, each file as large as it says', () => {
    const png = manifest.icons.filter((i) => i.type === 'image/png');
    for (const size of ['192x192', '512x512']) expect(png.some((i) => i.sizes === size && i.purpose === 'any')).toBe(true);
    expect(png.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of png) {
      const [w, h] = pngSize(join(PUBLIC, icon.src));
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
    for (const icon of manifest.icons) expect(existsSync(join(PUBLIC, icon.src))).toBe(true);
  });

  it('has the home screen icon iOS takes (a PNG of 180 px, named in the root layout)', () => {
    expect(pngSize(join(PUBLIC, 'icons/apple-touch-icon-180.png'))).toEqual([180, 180]);
    const layout = readFileSync(join(__dirname, '../../../app/layout.tsx'), 'utf8');
    expect(layout).toContain('/icons/apple-touch-icon-180.png');
    expect(layout).toContain('<html lang="de">');
  });

  it('offers shortcuts only to pages of the app', () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    for (const s of manifest.shortcuts) expect(s.url === '/app' || s.url.startsWith('/app/')).toBe(true);
  });

  it('keeps the share target the service worker answers (POST of "files" to /share-target)', () => {
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    expect(manifest.share_target.action).toBe('/share-target');
    expect(manifest.share_target.method).toBe('POST');
    expect(manifest.share_target.params.files[0].name).toBe('files');
    expect(sw).toContain("const SHARE_PATH = '/share-target';");
    expect(sw).toContain("form.getAll('files')");
  });
});
