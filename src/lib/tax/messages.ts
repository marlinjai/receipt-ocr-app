import type { TreatmentOrigin } from './facts';
import type { OpenCheckKind, Purpose } from './types';

/** German wording for the finance screens, in one place. */

export const CHECK_LABELS: Record<OpenCheckKind, string> = {
  no_date: 'Datum fehlt',
  no_amount: 'Betrag fehlt',
  no_exchange_rate: 'Wechselkurs fehlt',
  amount_estimated: 'Betrag geschätzt (Referenzkurs, noch keine Zahlung zugeordnet)',
  no_allocation: 'Noch nicht entschieden, wer die Kosten trägt',
  allocation_exceeds_whole: 'Anteile ergeben mehr als 100 %',
  no_form_line: 'Zeile der EÜR fehlt',
  no_employment_line: 'Zeile der Anlage N fehlt',
  small_business_unanswered: 'Frage zur Kleinunternehmerregelung offen',
  regular_taxation_not_computed: 'Regelbesteuerung wird noch nicht berechnet',
  meal_incomplete: 'Bewirtung unvollständig (Teilnehmer, Anlass oder Ort fehlen)',
  meal_without_register_facts: 'Bewirtung ohne Angaben aus dem Verzeichnis',
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  business: 'Betrieb',
  study: 'Studium',
  employment: 'Anstellung',
  private: 'Privat',
};

export const ORIGIN_LABELS: Record<TreatmentOrigin, string> = {
  item: 'für diesen Beleg entschieden',
  vendor_rule: 'Regel für den Lieferanten',
  legacy_columns: 'aus Zuordnung und Geschäftsanteil des Belegs',
  category_default: 'Vorgabe der Kategorie',
  meal_register: 'laut Bewirtungsverzeichnis',
};

/** Wording for the error codes the finance server actions return. */
export function financeActionMessage(error: string, detail?: string): string {
  switch (error) {
    case 'unauthorized':
      return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und erneut anmelden.';
    case 'forbidden':
      return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Speichern.';
    case 'not_found':
      return detail === 'rule_not_found'
        ? 'Diese Regel gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
        : 'Dieser Beleg wurde nicht gefunden. Er wurde möglicherweise gelöscht oder gehört zu einem anderen Arbeitsbereich.';
    case 'not_initialized':
      return 'Die Belegtabelle ist noch nicht angelegt. Bitte das Dashboard einmal öffnen und dann erneut versuchen.';
    case 'invalid_input':
      switch (detail) {
        case 'allocation_exceeds_whole':
          return 'Die Anteile ergeben zusammen mehr als 100 %.';
        case 'nothing_allocated':
          return 'Bitte mindestens einen Anteil angeben. Für einen rein privaten Beleg „Privat“ wählen.';
        case 'form_line_required':
          return 'Für den betrieblichen Anteil bitte eine Zeile der EÜR wählen.';
        case 'employment_line_required':
          return 'Für den Anteil Studium oder Anstellung bitte eine Zeile der Anlage N wählen.';
        case 'meal_row':
          return 'Bewirtungen werden im Bewirtungsverzeichnis erfasst, nicht hier.';
        case 'no_vendor':
          return 'Dieser Beleg hat keinen Lieferanten, für den eine Regel gelten könnte.';
        case 'invalid_date':
          return 'Das Datum „gilt ab“ ist ungültig.';
        default:
          return 'Eine Eingabe ist ungültig. Bitte Anteile und Zeilen prüfen.';
      }
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen; wenn es wieder scheitert, die Verbindung prüfen.';
  }
}
