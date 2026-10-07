/**
 * A failed upload step, with the one distinction the capture queue needs:
 *  - `network`: the request never reached the server (offline, connection lost). Worth retrying later, unchanged.
 *  - `auth`: the session has expired. Retrying is pointless until the user has signed in again.
 *  - `server`: the server answered with an error. May or may not succeed on retry.
 */
export type UploadFailureKind = 'network' | 'auth' | 'server';

export class UploadStepError extends Error {
  readonly kind: UploadFailureKind;
  constructor(kind: UploadFailureKind, message: string) {
    super(message);
    this.name = 'UploadStepError';
    this.kind = kind;
  }
}

/** Classify any thrown value from the pipeline. A failed `fetch` throws a TypeError. */
export function uploadFailureKind(err: unknown): UploadFailureKind {
  if (err instanceof UploadStepError) return err.kind;
  if (err instanceof TypeError) return 'network';
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('load failed')) {
    return 'network';
  }
  return 'server';
}
