import { describe, expect, it } from 'vitest';
import { rereadNote } from '../reread';

describe('rereadNote: what a person is told after "Seite neu lesen"', () => {
  it('says it is done when nothing is in doubt', () => {
    expect(rereadNote({ ok: true, reviewFlags: [] })).toMatchObject({ tone: 'ok' });
  });

  it('names every doubt the new reading left', () => {
    const note = rereadNote({ ok: true, reviewFlags: ['date_conflict', 'total_conflict'] });
    expect(note.tone).toBe('warn');
    expect(note.text).toContain('Rechnungsdatums');
    expect(note.text).toContain('Gesamtbetrags');
  });

  it('says that nothing was changed when the model or the page was not to be had', () => {
    for (const error of ['model_unavailable', 'page_unavailable', 'failed'] as const) {
      const note = rereadNote({ ok: false, error });
      expect(note.tone).toBe('danger');
      expect(note.text).toContain('nichts geändert');
    }
    expect(rereadNote({ ok: false, error: 'no_text' }).text).toContain('kein erkannter Text');
    expect(rereadNote({ ok: false, error: 'no_file' }).text).toContain('keine Datei');
  });
});
