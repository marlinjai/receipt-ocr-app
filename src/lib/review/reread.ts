import { REASON_TEXT, type ReadFlag } from './reasons';

/**
 * The outcome of "Seite neu lesen" (a new reading of a stored receipt with
 * the model that sees the page), and what the person is told about it.
 */

export type RereadError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  /** The row holds no file a page could be read from. */
  | 'no_file'
  /** No recognized text is stored with the row, so nothing could check the model's answer. */
  | 'no_text'
  /** The model did not answer (provider down, timeout, a refusal). Nothing was written. */
  | 'model_unavailable'
  /** The model answered, but could not be given the page (file gone, unreadable, over a limit). Nothing was written. */
  | 'page_unavailable'
  | 'failed';

export type RereadResult =
  | {
      ok: true;
      /** The doubts of the new reading, as stored for the review list. */
      reviewFlags: ReadFlag[];
    }
  | { ok: false; error: RereadError };

const ERROR_TEXT: Record<RereadError, string> = {
  unauthorized: 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.',
  forbidden: 'Dafür fehlt die Berechtigung.',
  not_found: 'Der Beleg wurde nicht gefunden.',
  no_file: 'An diesem Beleg hängt keine Datei, die gelesen werden könnte.',
  no_text: 'Zu diesem Beleg ist kein erkannter Text gespeichert, und die Seite allein ließ sich nicht lesen. Bitte das Foto neu aufnehmen.',
  model_unavailable: 'Das Sprachmodell hat nicht geantwortet. Am Beleg wurde nichts geändert. Bitte später noch einmal versuchen.',
  page_unavailable: 'Die Seite konnte nicht gelesen werden: Die Datei fehlt, ist zu groß oder lässt sich nicht öffnen. Am Beleg wurde nichts geändert.',
  failed: 'Das neue Lesen ist fehlgeschlagen. Am Beleg wurde nichts geändert.',
};

export interface RereadNote {
  tone: 'ok' | 'warn' | 'danger';
  text: string;
}

/** What to say after a new reading: that it is done, with every doubt it left, or why nothing changed. */
export function rereadNote(result: RereadResult): RereadNote {
  if (!result.ok) return { tone: 'danger', text: ERROR_TEXT[result.error] };
  const done = 'Neu gelesen: Datum, Beträge und Währung stehen jetzt so am Beleg, wie die Seite sie zeigt. Ein eingetragener Händler bleibt.';
  if (result.reviewFlags.length === 0) return { tone: 'ok', text: done };
  return { tone: 'warn', text: `${done} Bitte prüfen: ${result.reviewFlags.map((flag) => REASON_TEXT[flag]).join(' ')}` };
}
