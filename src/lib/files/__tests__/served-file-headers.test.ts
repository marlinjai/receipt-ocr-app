import { describe, expect, it } from 'vitest';
import { SANDBOX_POLICY, servedFileHeaders } from '../served-file-headers';

describe('servedFileHeaders', () => {
  it.each(['application/pdf', 'image/png', 'image/jpeg', 'IMAGE/JPEG; charset=binary', 'image/webp'])('%s is shown as it is, never sniffed', (type) => {
    expect(servedFileHeaders(type)).toEqual({ 'X-Content-Type-Options': 'nosniff' });
  });

  it.each(['application/xml', 'text/xml; charset=utf-8', 'image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/octet-stream', ''])(
    '%s runs nothing: sandboxed with no permissions, never sniffed',
    (type) => {
      expect(servedFileHeaders(type)).toEqual({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SANDBOX_POLICY });
    },
  );

  it('the sandbox runs nothing and loads nothing from the network; inline styles only, for the XML viewer', () => {
    expect(SANDBOX_POLICY).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(SANDBOX_POLICY).not.toContain('allow-');
    expect(SANDBOX_POLICY).not.toContain('script-src');
  });
});
