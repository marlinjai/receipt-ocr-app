import { describe, expect, it, vi } from 'vitest';
import type { Column, Row } from '@marlinjai/data-table-core';

// The component file imports the dashboard's server actions through the table package; only the pure tool executor is used here.
vi.mock('@marlinjai/data-table-react', () => ({}));
vi.mock('react', async (importOriginal) => importOriginal());

import { executeReadOnlyTool } from './AiChatSidebar';

const columns = [
  { id: 'c-name', name: 'Name', type: 'text' },
  { id: 'c-text', name: 'OCR Text', type: 'text' },
] as unknown as Column[];
const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, tableId: 't', cells: { 'c-name': `Beleg ${i}`, 'c-text': '' } })) as unknown as Row[];

describe('the assistant reads receipts without their text unless it asks', () => {
  it('returns rows with the empty text cell and does not fetch anything', async () => {
    const loadText = vi.fn(async () => 'page');
    const out = JSON.parse(await executeReadOnlyTool('get_rows', { limit: 3 }, rows, columns, new Map(), loadText));
    expect(out).toHaveLength(3);
    expect(out[0]['OCR Text']).toBe('');
    expect(loadText).not.toHaveBeenCalled();
  });

  it('fetches the text per receipt when asked, for at most 25 receipts', async () => {
    const loadText = vi.fn(async (id: string) => `text of ${id}`);
    const out = JSON.parse(await executeReadOnlyTool('get_rows', { includeText: true, limit: 50 }, rows, columns, new Map(), loadText));
    expect(out).toHaveLength(25);
    expect(out[0]['OCR Text']).toBe('text of r0');
    expect(loadText).toHaveBeenCalledTimes(25);
  });

  it('says an empty text for a receipt whose text could not be loaded, and still answers', async () => {
    const loadText = vi.fn(async (id: string) => {
      if (id === 'r1') throw new Error('offline');
      return 'ok';
    });
    const out = JSON.parse(await executeReadOnlyTool('get_rows', { includeText: true, limit: 2 }, rows, columns, new Map(), loadText));
    expect(out.map((r: Record<string, string>) => r['OCR Text'])).toEqual(['ok', '']);
  });
});
