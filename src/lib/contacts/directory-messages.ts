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
