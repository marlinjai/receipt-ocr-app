import { describe, it, expect } from 'vitest';
import { matchSourceFile, type DriveFile } from './drive-client';

// Mirrors the real Rechnungen folder drift observed 2026-07-24.
const FILES: DriveFile[] = [
  { id: '1', name: 'Invoice-KZZXHTSF-0003.pdf' },
  { id: '2', name: 'eleven labs.pdf' },
  { id: '3', name: 'Rechnung Dji Mic Mini.pdf' },
  { id: '4', name: 'rechung-vercel-hosting-landingpage&app.pdf' },
];

describe('matchSourceFile', () => {
  it('matches exact names first', () => {
    expect(matchSourceFile('Invoice-KZZXHTSF-0003.pdf', FILES)?.id).toBe('1');
  });
  it('falls back to normalized matching (case/space/hyphen drift)', () => {
    expect(matchSourceFile('eleven-labs.pdf', FILES)?.id).toBe('2');
    expect(matchSourceFile('rechnung dji mic mini.PDF', FILES)?.id).toBe('3');
  });
  it('does not guess across genuinely different names', () => {
    // sheet says rechnung-vercel-hosting.pdf; drive has the landingpage&app variant + typo
    expect(matchSourceFile('rechnung-vercel-hosting.pdf', FILES)).toBeNull();
    expect(matchSourceFile('github-actions-screenshot.jpg', FILES)).toBeNull();
  });
  it('handles blanks', () => {
    expect(matchSourceFile('', FILES)).toBeNull();
    expect(matchSourceFile('   ', FILES)).toBeNull();
  });
});
