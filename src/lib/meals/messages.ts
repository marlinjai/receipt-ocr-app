import type { MealBatchNotice } from './batch';
import { MISSING_FIELD_LABELS, mealStatus, type ExclusionReason, type MissingField } from './rules';
import type { MealRecord } from './types';

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
    case 'contact_stale':
      return 'Dieser Kontakt wurde inzwischen von jemand anderem geändert. Bitte die Seite neu laden und die Änderung erneut vornehmen.';
    case 'contact_archived':
      return 'Ein archivierter Kontakt kann nicht neu hinzugefügt werden. Bitte den Kontakt zuerst wiederherstellen.';
    case 'not_initialized':
      return 'Die Belegtabelle ist noch nicht auf dem aktuellen Stand. Bitte das Dashboard einmal öffnen und dann erneut versuchen.';
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen; wenn es wieder scheitert, die Verbindung prüfen.';
  }
}

/** Where a receipt marked "Keine Bewirtung" is found again; shown in the confirmation before it is marked. */
export const DISMISSED_HINT =
  'Die Belege stehen danach unten auf dieser Seite unter „Keine Bewirtung“ und lassen sich dort mit einem Klick wieder aufnehmen.';

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

/**
 * What an incomplete entry lacks, short enough for one line of a list row:
 * up to two facts by name, beyond that their number. The full list goes into
 * `missingList` for a tooltip and for screen readers.
 */
export function missingSummary(missing: MissingField[]): string {
  if (missing.length === 0) return 'vollständig';
  if (missing.length <= 2) return `fehlt: ${missingList(missing)}`;
  return `${missing.length} fehlen`;
}

export function missingList(missing: MissingField[]): string {
  return missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ');
}

/**
 * What to tell the user when a saved edit took an entry out of the register
 * table they are looking at, in one sentence that says where it is now. Null
 * when the entry is still a complete entry of the shown year: then the table
 * itself shows the outcome.
 */
export function registerEditNotice(record: MealRecord, shownYear: number): MealBatchNotice | null {
  const subject = `„${record.vendor || record.name || 'Beleg'}“`;
  const status = mealStatus(record);
  if (status.kind === 'incomplete') {
    return {
      tone: 'warn',
      text: `${subject} ist jetzt unvollständig (es fehlt: ${missingList(status.missing)}) und steht deshalb nicht mehr im Verzeichnis, sondern unter „Unvollständig“.`,
    };
  }
  if (status.kind === 'excluded') {
    return {
      tone: 'ok',
      text: `${subject} wird jetzt gesondert gezählt (${EXCLUSION_LABELS[status.reason]}) und steht nicht mehr im Verzeichnis.`,
    };
  }
  if (status.kind === 'not_a_meal') {
    return {
      tone: 'ok',
      text: `${subject} wird nicht mehr als Bewirtung geführt und lässt sich unten auf dieser Seite unter „Keine Bewirtung“ wieder aufnehmen.`,
    };
  }
  const year = record.date ? Number(record.date.slice(0, 4)) : null;
  if (year !== shownYear) {
    return {
      tone: 'ok',
      text: year
        ? `${subject} steht jetzt im Verzeichnis ${year}.`
        : `${subject} hat kein Datum mehr und steht deshalb in keinem Jahr.`,
    };
  }
  return null;
}
