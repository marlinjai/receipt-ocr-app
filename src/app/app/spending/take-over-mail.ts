import { runUploadPipeline, type PipelineDeps } from '@/lib/upload/pipeline';

/**
 * Take a mail attachment the loop found into the normal upload path: fetch
 * its bytes from the server, then run the same pipeline as any upload (hash,
 * duplicate check, upload, reading, save), so the reader and the vendor rules
 * run as for any receipt. Pure apart from the injected steps, so it is tested
 * without a browser.
 */

export type TakeOverOutcome =
  | { kind: 'done'; rowId: string }
  /** Exactly this file is already a receipt of the company: nothing was uploaded. */
  | { kind: 'duplicate'; rowId: string }
  | { kind: 'failed'; reason: 'not_found' | 'mailbox_off' | 'mailbox_auth' | 'mailbox_unavailable' | 'too_large' | 'forbidden' | 'upload' | 'network'; detail?: string };

export interface TakeOverDeps {
  fetchImpl: typeof fetch;
  pipeline: PipelineDeps;
  run?: typeof runUploadPipeline;
}

export async function takeOverMail(candidateId: string, deps: TakeOverDeps): Promise<TakeOverOutcome> {
  let res: Response;
  try {
    res = await deps.fetchImpl(`/api/spending/mail-attachment/${encodeURIComponent(candidateId)}`, { cache: 'no-store' });
  } catch {
    return { kind: 'failed', reason: 'network' };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404) return { kind: 'failed', reason: 'not_found' };
    if (res.status === 401 || res.status === 403) return { kind: 'failed', reason: 'forbidden' };
    if (res.status === 413) return { kind: 'failed', reason: 'too_large' };
    if (body.error === 'not_configured') return { kind: 'failed', reason: 'mailbox_off' };
    if (body.error === 'auth_failed') return { kind: 'failed', reason: 'mailbox_auth' };
    return { kind: 'failed', reason: 'mailbox_unavailable', detail: body.error };
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : 'rechnung.pdf';
  const file = new File([blob], name, { type: res.headers.get('Content-Type') ?? blob.type });
  try {
    const outcome = await (deps.run ?? runUploadPipeline)(file, deps.pipeline);
    return outcome.kind === 'duplicate' ? { kind: 'duplicate', rowId: outcome.existing.rowId } : { kind: 'done', rowId: outcome.rowId };
  } catch (e) {
    return { kind: 'failed', reason: 'upload', detail: e instanceof Error ? e.message : undefined };
  }
}

/** What happened, in words a person can act on. `linked`: whether the receipt was then linked to the payment. */
export function takeOverMessage(outcome: TakeOverOutcome, linked = false): string {
  if (outcome.kind === 'done') return linked ? 'Als Beleg übernommen und mit der Zahlung verknüpft.' : 'Als Beleg übernommen, aber noch nicht mit der Zahlung verknüpft.';
  if (outcome.kind === 'duplicate') return linked ? 'Diese Rechnung war schon als Beleg da; sie ist jetzt mit der Zahlung verknüpft.' : 'Diese Rechnung ist schon als Beleg da, aber noch nicht mit der Zahlung verknüpft.';
  switch (outcome.reason) {
    case 'not_found':
      return 'Diese Mail oder ihr Anhang ist nicht mehr im Postfach. Bitte den Beleg anders hochladen.';
    case 'mailbox_off':
      return 'Das Ausgaben-Postfach ist auf dem Server nicht eingerichtet.';
    case 'mailbox_auth':
      // How to grant it again: README, "Ausgaben-Postfach".
      return 'Der Zugang zum Ausgaben-Postfach ist abgelaufen. Er muss auf dem Server neu erteilt werden; bis dahin den Beleg bitte selbst hochladen.';
    case 'too_large':
      return 'Dieser Anhang ist zu groß für einen Beleg (mehr als 20 MB). Bitte die Rechnung selbst hochladen.';
    case 'forbidden':
      return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Hochladen.';
    case 'upload':
      return `Das Hochladen hat nicht geklappt${outcome.detail ? ` (${outcome.detail})` : ''}. Bitte noch einmal versuchen.`;
    case 'network':
      return 'Keine Verbindung zum Server. Bitte noch einmal versuchen.';
    default:
      return 'Das Postfach antwortet gerade nicht. Bitte später noch einmal versuchen.';
  }
}
