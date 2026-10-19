/**
 * German wording of the bank connection's outcomes and error codes. Pure, so
 * the screen and its tests share it. A code is never bank data.
 */

const SOURCE_UNSUPPORTED =
  'Dieses Konto wird aus einer PayPal- oder Klarna-Liste gefüllt. Die Bankschnittstelle kann es nicht fortsetzen, weil beide Quellen dieselben Käufe verschieden beschreiben. Für die Live-Verbindung bitte ein eigenes Konto anlegen und die Liste für die Tage danach nicht mehr einlesen, oder beim Datei-Import bleiben.';

const MESSAGES: Record<string, string> = {
  feature_off: 'Die Live-Anbindung an Banken ist auf diesem Server nicht eingeschaltet. Die Konten werden weiter aus Dateien eingelesen.',
  aspsp_not_offered: 'Diese Bank wird über die Bankschnittstelle nicht angeboten. Das Konto bleibt beim Datei-Import.',
  wrong_aspsp: 'Diese Bank wird über die Bankschnittstelle nicht angeboten. Das Konto bleibt beim Datei-Import.',
  account_source_unsupported: SOURCE_UNSUPPORTED,
  format_mismatch: SOURCE_UNSUPPORTED,
  invalid_aspsp: 'Bitte eine Bank aus der Liste wählen.',
  account_not_found: 'Dieses Konto gibt es in dieser Firma nicht (mehr). Bitte die Seite neu laden.',
  connection_not_found: 'Diese Verbindung gibt es in dieser Firma nicht (mehr). Bitte die Seite neu laden.',
  not_found: 'Diese Verbindung gibt es in dieser Firma nicht (mehr). Bitte die Seite neu laden.',
  state_invalid: 'Diese Antwort der Bank gehört zu keiner offenen Freigabe dieser Firma: schon verwendet, oder in einer anderen Firma begonnen. Bitte die Verbindung neu starten.',
  state_expired: 'Die Freigabe bei der Bank hat zu lange gedauert. Bitte neu starten.',
  consent_timed_out: 'Die Freigabe bei der Bank hat zu lange gedauert. Bitte neu starten.',
  consent_refused: 'Die Freigabe wurde bei der Bank abgebrochen oder abgelehnt.',
  no_accounts: 'Die Bank hat kein Konto freigegeben.',
  invalid_choice: 'Dieses Konto gehört nicht zur Freigabe. Bitte die Seite neu laden.',
  invalid_notice: 'Diesen Hinweis gibt es nicht mehr. Bitte die Seite neu laden.',
  session_expired: 'Die Freigabe bei der Bank ist abgelaufen.',
  session_revoked: 'Die Freigabe wurde bei der Bank beendet oder widerrufen.',
  rate_limited: 'Die Bank lässt gerade keine weiteren Abrufe zu. Der nächste Lauf versucht es wieder.',
  bank_unavailable: 'Die Bank hat nicht oder mit einem Fehler geantwortet. Der nächste Lauf versucht es wieder.',
  account_not_accessible: 'Die Bank gibt dieses Konto über die Freigabe nicht heraus.',
  authorization_code: 'Die Antwort der Bank war abgelaufen oder ungültig. Bitte die Verbindung neu starten.',
  credentials: 'Die Bankschnittstelle nimmt den Schlüssel dieser Anwendung nicht an. Das muss auf dem Server eingerichtet werden.',
  network: 'Die Bankschnittstelle war nicht erreichbar.',
  import_failed: 'Die abgeholten Zahlungen konnten nicht gespeichert werden. Der nächste Lauf versucht es wieder.',
  forbidden: 'Für diese Firma fehlt die Berechtigung, Verbindungen einzurichten.',
  unauthorized: 'Bitte neu anmelden.',
  failed: 'Das hat nicht geklappt. Bitte noch einmal versuchen.',
  invalid_input: 'Das hat nicht geklappt. Bitte die Seite neu laden.',
};

/** The German text of a code such as `bank_error:rate_limited`, `state_invalid` or `parse_unreadable_row`. */
export function bankMessage(code: string | null | undefined): string {
  if (!code) return MESSAGES.failed;
  const parts = code.split(':');
  for (const part of [...parts].reverse()) {
    if (MESSAGES[part]) return MESSAGES[part];
    if (part.startsWith('parse_')) return 'Die Antwort der Bank ließ sich nicht lesen; nichts wurde übernommen. Der nächste Lauf versucht es wieder.';
  }
  return `Unbekannter Fehler (${code.replace(/[^a-z0-9_:]/gi, '').slice(0, 60)}).`;
}

/** The notice after the return from the bank (`?bank=` on the finance page). */
export function returnMessage(value: string | null | undefined): { text: string; ok: boolean } | null {
  if (!value) return null;
  if (value === 'verbunden') return { text: 'Die Bank ist verbunden. „Jetzt abholen“ holt die Zahlungen der letzten 89 Tage; danach geschieht das täglich von selbst.', ok: true };
  if (value === 'konto_waehlen') return { text: 'Die Bank hat mehrere Konten freigegeben. Bitte unten wählen, welches zu diesem Konto gehört.', ok: true };
  if (value.startsWith('fehler:')) return { text: bankMessage(value.slice('fehler:'.length)), ok: false };
  return null;
}

/** The institution whose name the account's label contains (the longest such name), for preselecting it. */
export function preselectInstitution<T extends { name: string }>(label: string, institutions: readonly T[]): T | null {
  const text = label.toLowerCase();
  let best: T | null = null;
  for (const i of institutions) {
    const name = i.name.toLowerCase().trim();
    if (name.length >= 3 && text.includes(name) && (!best || name.length > best.name.length)) best = i;
  }
  return best;
}
