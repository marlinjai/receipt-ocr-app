import type { ExclusionReason } from './rules';

/** Wording for the error codes the meal server actions return. */
export function mealActionMessage(error: string, detail?: string): string {
  switch (error) {
    case 'unauthorized':
      return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und erneut anmelden; die Eingaben in diesem Formular bleiben bis dahin stehen.';
    case 'forbidden':
      return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Speichern.';
    case 'not_found':
      return detail === 'unknown_contact'
        ? 'Ein ausgewählter Kontakt existiert nicht mehr. Bitte den Teilnehmer entfernen und neu auswählen.'
        : 'Dieser Beleg wurde nicht gefunden. Er wurde möglicherweise gelöscht oder gehört zu einem anderen Arbeitsbereich.';
    case 'invalid_input':
      return 'Eine Eingabe ist ungültig. Bitte Beträge, Datum und Auswahlfelder prüfen.';
    case 'contact_duplicate':
      return 'Diesen Kontakt gibt es bereits.';
    case 'contact_invalid':
      return detail === 'too_long' ? 'Der Text ist zu lang.' : 'Bitte einen Namen eingeben.';
    case 'contact_archived':
      return 'Ein archivierter Kontakt kann nicht neu hinzugefügt werden. Bitte den Kontakt zuerst wiederherstellen.';
    case 'not_initialized':
      return 'Die Belegtabelle ist noch nicht auf dem aktuellen Stand. Bitte das Dashboard einmal öffnen und dann erneut versuchen.';
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen; wenn es wieder scheitert, die Verbindung prüfen.';
  }
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  private: 'Privat zugeordnet',
  staff_meal_internal: 'Mitarbeiterbewirtung',
  travel_meal: 'Verpflegung auf Reise',
};

export function formatEuro(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

/** `YYYY-MM-DD` to `DD.MM.YYYY`, as a plain calendar day. */
export function formatDay(isoDay: string | null): string {
  if (!isoDay) return 'ohne Datum';
  const [y, m, d] = isoDay.split('-');
  return `${d}.${m}.${y}`;
}
