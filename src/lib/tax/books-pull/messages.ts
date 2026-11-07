import type { MirrorConflictReason, MirrorSkipReason } from '../books-mirror';
import type { BooksPullFailure } from './service';

/** What a failed pull from the Books says to the person, and what to do next. */
export function booksPullFailureMessage(code: string): string {
  switch (code as BooksPullFailure) {
    case 'not_configured':
      return 'Die Verbindung zu den Books ist auf dem Server nicht eingerichtet (es fehlt der Schlüssel der Firma). Bis dahin kommen keine Rechnungen aus den Books.';
    case 'books_key_refused':
      return 'Die Books haben den Schlüssel dieser App abgelehnt (unbekannt, widerrufen oder abgelaufen). Ein neuer Schlüssel muss auf dem Server hinterlegt werden.';
    case 'books_forbidden':
      return 'Die Books sind für diese Firma nicht freigeschaltet, oder der Schlüssel darf sie nicht lesen.';
    case 'books_not_provisioned':
      return 'Für diese Firma sind in den Books noch keine Rechnungen eingerichtet.';
    case 'books_unavailable':
      return 'Die Books haben gerade nicht geantwortet. Der nächste Abruf versucht es wieder; du kannst es auch gleich noch einmal versuchen.';
    case 'books_bad_response':
    case 'books_company_changed':
    case 'books_too_many_pages':
      return 'Die Antwort der Books war nicht lesbar. Es wurde nichts übernommen; das ist ein Fehler, der behoben werden muss.';
    case 'no_workspace':
      return 'Keine Firma in dieser App gehört zum Schlüssel der Books. Es wurde nichts übernommen.';
    case 'ambiguous_workspace':
      return 'Mehrere Arbeitsbereiche dieser App gehören zur Firma des Schlüssels; welcher die Rechnungen bekommt, ist nicht eindeutig. Es wurde nichts übernommen.';
    case 'other_company':
      return 'Der Schlüssel der Books gehört zu einer anderen Firma als dieser. Hier wurde nichts übernommen.';
    case 'apply_failed':
      return 'Das Übernehmen der Rechnungen ist fehlgeschlagen. Es wurde nichts geändert; bitte später erneut versuchen.';
    default:
      return 'Das Abholen aus den Books ist fehlgeschlagen. Es wurde nichts geändert.';
  }
}

export const BOOKS_CONFLICT_LABELS: Record<MirrorConflictReason | 'replaced_invoice_unknown', string> = {
  register_differs: 'Betrag, Steuer oder Datum weichen von der hier erfassten Rechnung gleicher Nummer ab. Welche Angabe stimmt, entscheidest du: in den Books korrigieren oder hier die Rechnung anpassen.',
  number_taken: 'Die Nummer gehört hier schon zu einer anderen Rechnung aus den Books.',
  partial_credit_note: 'Eine Gutschrift über weniger (oder mehr) als die ganze Rechnung; die App übernimmt nur Stornos über den vollen Betrag.',
  credit_note_without_invoice: 'Eine Gutschrift, deren Rechnung nicht mitkam.',
  cancelled_without_credit_note: 'In den Books storniert, aber ohne Gutschrift.',
  unsupported_tax: 'Ein Steuersatz, den die App bei Rechnungen nicht führt (nur 19 und 7 Prozent, oder ohne Umsatzsteuer).',
  invalid_document: 'Das Dokument ist unvollständig und wurde nicht übernommen.',
  replaced_invoice_unknown: 'Eine Ersatzrechnung, deren ursprüngliche Rechnung hier nicht vorliegt.',
};

export const BOOKS_SKIP_LABELS: Record<MirrorSkipReason, string> = {
  before_register: 'älter als die hier geführten Rechnungen',
  not_euro: 'nicht in Euro',
};
