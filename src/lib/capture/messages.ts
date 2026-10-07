/**
 * German wording for upload failures on the capture screen. The upload steps
 * are shared with the (English) batch uploader and report in English; the
 * capture screen is German, so known messages are translated here and anything
 * unknown is shown as it is rather than hidden.
 */
const TRANSLATIONS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/cannot be read by the browser/i, () => 'Dieses Bildformat kann der Browser nicht lesen. Bitte neu fotografieren.'],
  [/could not be converted/i, () => 'Das Foto konnte nicht für den Upload umgewandelt werden.'],
  [/session has expired/i, () => 'Die Anmeldung ist abgelaufen.'],
  [/no connection|network error|upload aborted|failed to fetch/i, () => 'Keine Verbindung zum Server.'],
  [/duplicate check failed \((\d+)\)/i, (m) => `Die Prüfung auf doppelte Dateien ist fehlgeschlagen (Fehler ${m[1]}).`],
  [/ocr failed \((\d+)\)/i, (m) => `Die Texterkennung ist fehlgeschlagen (Fehler ${m[1]}).`],
  [/upload failed with status (\d+)/i, (m) => `Der Upload wurde vom Speicher abgelehnt (Fehler ${m[1]}).`],
  [/upload request failed|failed to get file info/i, () => 'Der Upload wurde vom Server abgelehnt.'],
  [/receipt not found/i, () => 'Der Beleg wurde nicht gefunden.'],
];

export function captureErrorText(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'Das Foto konnte nicht verarbeitet werden.';
  for (const [pattern, translate] of TRANSLATIONS) {
    const match = pattern.exec(text);
    if (match) return translate(match);
  }
  return text;
}
