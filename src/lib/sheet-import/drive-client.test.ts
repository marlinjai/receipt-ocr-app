import { describe, it, expect } from 'vitest';
import { matchSourceFile, classifyBrowseEntries, FOLDER_MIME, SPREADSHEET_MIME, type DriveFile } from './drive-client';

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

describe('classifyBrowseEntries', () => {
  it('splits folders from usable files and drops the rest', () => {
    const { folders, files } = classifyBrowseEntries([
      { id: 'f1', name: 'Rechnungen', mimeType: FOLDER_MIME },
      { id: 's1', name: 'Lola Invoices', mimeType: SPREADSHEET_MIME },
      { id: 'p1', name: 'invoice.pdf', mimeType: 'application/pdf' },
      { id: 'i1', name: 'scan.png', mimeType: 'image/png' },
      { id: 'x1', name: 'notes.gdoc', mimeType: 'application/vnd.google-apps.document' },
      { id: 'x2', name: 'movie.mp4', mimeType: 'video/mp4' },
    ]);
    expect(folders.map((f) => f.id)).toEqual(['f1']);
    expect(files.map((f) => f.id)).toEqual(['s1', 'p1', 'i1']);
  });
});
