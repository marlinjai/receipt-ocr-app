import { financeActionMessage } from '../messages';

/** What a failed write of wages, return items or church months tells the person, in German like the rest of the screen. */
export function incomeTaxActionMessage(error: string, detail?: string): string {
  if (error === 'not_found') {
    return detail === 'item_not_found'
      ? 'Diesen Eintrag gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.'
      : 'Diese Lohnangabe gibt es nicht mehr. Die Ansicht wurde vermutlich in einem anderen Fenster geändert; bitte neu laden.';
  }
  if (error === 'invalid_input') {
    switch (detail) {
      case 'wage_entry_taken':
        return 'Für diesen Arbeitgeber und Monat ist schon eine Angabe gespeichert. Bitte die vorhandene ändern.';
      case 'employer_required':
        return 'Bitte eine Bezeichnung für den Arbeitgeber eingeben.';
      case 'employer_too_long':
        return 'Die Bezeichnung des Arbeitgebers ist zu lang (höchstens 60 Zeichen).';
      case 'invalid_month':
        return 'Bitte einen Monat wählen oder „Lohnsteuerbescheinigung (ganzes Jahr)“.';
      case 'invalid_amount':
        return 'Bitte gültige Beträge eingeben (nicht negativ).';
      case 'wage_tax_above_gross':
        return 'Die Lohnsteuer ist höher als der Bruttolohn. Bitte die Beträge prüfen.';
      case 'invalid_days':
        return 'Bitte eine Zahl von Tagen zwischen 1 und 366 eingeben.';
      case 'invalid_distance':
        return 'Bitte die einfache Entfernung in vollen Kilometern eingeben.';
      case 'note_too_long':
        return 'Die Notiz ist zu lang (höchstens 200 Zeichen).';
      case 'invalid_church_months':
        return 'Die Monate der Kirchensteuerpflicht konnten nicht gelesen werden. Bitte neu laden.';
      case 'invalid_federal_state':
        return 'Bitte ein Bundesland aus der Liste wählen.';
      case 'invalid_year':
        return 'Dieses Jahr kann hier nicht bearbeitet werden.';
      case 'invalid_key':
        return 'Diese Art von Eintrag kennt die App nicht. Bitte neu laden.';
      default:
        return 'Die Eingabe ist unvollständig oder ungültig.';
    }
  }
  return financeActionMessage(error, detail);
}
