/**
 * Wording for the errors the contact directory returns. Plain strings, safe to import
 * in client components. Codes come from src/lib/contacts/directory.ts.
 */
export function directoryMessage(error: string): string {
  switch (error) {
    case 'not_found':
      return 'Dieser Kontakt wurde nicht gefunden. Vielleicht wurde er schon gelöscht oder gehört zu einem anderen Konto.';
    case 'duplicate':
      return 'Diesen Kontakt gibt es bereits.';
    case 'stale':
      return 'Dieser Kontakt wurde inzwischen geändert. Bitte die Seite neu laden und die Änderung erneut vornehmen.';
    case 'invalid':
      return 'Eine Angabe ist ungültig. Bitte Namen, Postleitzahl und Land prüfen.';
    case 'not_organization':
      return 'Eine Person kann nur mit einer Organisation verknüpft werden.';
    case 'same_contact':
      return 'Zum Zusammenführen bitte zwei verschiedene Kontakte wählen.';
    case 'kind_mismatch':
      return 'Eine Person und eine Organisation können nicht zusammengeführt werden.';
    case 'customer_number_conflict':
      return 'Die Kundennummer ist bereits vergeben. Bitte die Seite neu laden.';
    case 'invalid_value':
      return 'Ein Wert passt nicht zu seinem Feld. Bitte die markierte Eingabe prüfen.';
    case 'unknown_field':
      return 'Dieses Feld gibt es nicht mehr. Bitte die Seite neu laden.';
    case 'field_archived':
      return 'Dieses Feld ist archiviert. Sein Wert kann gelöscht, aber nicht mehr geändert werden.';
    case 'duplicate_field':
      return 'Ein Feld mit diesem Namen gibt es bereits (auch archivierte Felder behalten ihren Namen).';
    case 'field_not_found':
      return 'Dieses Feld wurde nicht gefunden. Bitte die Seite neu laden.';
    case 'unavailable':
      return 'Diese Aktion ist noch nicht verfügbar.';
    case 'directory_off':
      return 'Das Kontaktverzeichnis braucht die gemeinsame Kontaktdatenbank, die für dieses Konto nicht eingeschaltet ist.';
    case 'unauthorized':
      return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und erneut anmelden.';
    case 'forbidden':
      return 'Für dieses Konto fehlt die Berechtigung zum Ändern von Kontakten.';
    default:
      return 'Das hat nicht geklappt. Bitte erneut versuchen.';
  }
}

/** Wording shown under one input when the package refuses its value. */
export function fieldErrorMessage(error: string): string {
  switch (error) {
    case 'invalid_value':
      return 'Dieser Wert passt nicht zum Feld.';
    case 'field_archived':
      return 'Das Feld ist archiviert und nimmt keine neuen Werte an.';
    case 'unknown_field':
      return 'Das Feld gibt es nicht mehr.';
    default:
      return 'Diese Angabe ist ungültig.';
  }
}

/** Why printed names are held, in plain German. Codes come from `exportCoversRegister`. */
function heldReason(coverage: string | undefined): string {
  switch (coverage) {
    case 'changed':
      return 'weil sich das Bewirtungsverzeichnis seit dem letzten Export geändert hat';
    case 'no_hash':
      return 'weil der letzte Export noch ohne Abgleich mit dem Verzeichnis erstellt wurde';
    case 'recompute_failed':
      return 'weil das Verzeichnis gerade nicht mit dem letzten Export verglichen werden konnte';
    case 'no_workspaces':
      return 'weil nicht feststeht, mit welchem Stand der Export zu vergleichen wäre';
    default:
      return 'weil noch kein Export vorliegt';
  }
}

/**
 * What the confirmation says before one contact is erased. Plain German, and it
 * names which of the two outcomes for the printed names will happen.
 */
export function eraseConfirmation(
  preview: { meals: number; printedNames: 'removed' | 'held'; coverage?: string; linkedPersons: number },
  kind: 'person' | 'organization',
): string {
  const meals =
    preview.meals === 0
      ? 'Dieser Kontakt steht auf keiner Bewirtung.'
      : preview.meals === 1
        ? 'Dieser Kontakt steht auf 1 Bewirtung.'
        : `Dieser Kontakt steht auf ${preview.meals} Bewirtungen.`;
  const names =
    preview.meals === 0
      ? ''
      : preview.printedNames === 'removed'
        ? ' Die gedruckten Namen dort werden jetzt entfernt, weil das Bewirtungsverzeichnis seit dem letzten Export dieses Kontos unverändert ist: der Export enthält sie.'
        : ` Die gedruckten Namen dort bleiben zehn Jahre erhalten, ${heldReason(preview.coverage)}; nur die Verbindung zum Kontakt wird gelöst. Entfernt werden sie nur, wenn das aktuelle Verzeichnis mit dem letzten Export übereinstimmt.`;
  const persons =
    kind === 'organization' && preview.linkedPersons > 0
      ? ` ${preview.linkedPersons === 1 ? '1 verknüpfte Person bleibt' : `${preview.linkedPersons} verknüpfte Personen bleiben`} bestehen und wird nur von der Organisation gelöst.`.replace('bleiben bestehen und wird', 'bleiben bestehen und werden')
      : '';
  return `${meals}${names}${persons} Der Kontakt selbst wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`;
}
