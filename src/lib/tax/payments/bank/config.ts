/**
 * Whether the live bank connection (Enable Banking) is switched on, read by
 * name from the environment only. Pure apart from reading `env`. The values
 * are never logged or returned: `missing` holds names only.
 *
 * The feature is off unless BANK_FEED_ENABLED is "true" and the application's
 * id, private key and redirect address are all set. Off means: the payments
 * tab shows a quiet note instead of the bank controls, the actions refuse, the
 * machine sync route answers 503. The machine route also needs its own
 * BANK_SYNC_SECRET; the consent flow in the browser does not.
 */

export const BANK_ENV = {
  enabled: 'BANK_FEED_ENABLED',
  appId: 'ENABLE_BANKING_APPLICATION_ID',
  privateKey: 'ENABLE_BANKING_PRIVATE_KEY',
  redirectUrl: 'ENABLE_BANKING_REDIRECT_URL',
  syncSecret: 'BANK_SYNC_SECRET',
} as const;

export interface BankCredentials {
  appId: string;
  /** PEM text of the application's private RSA key. */
  privateKey: string;
  redirectUrl: string;
}

export type BankConfig =
  | { enabled: true; credentials: BankCredentials; missing: [] }
  | { enabled: false; credentials: null; /** The names of the settings that are missing; empty when the switch itself is off. */ missing: string[]; switchedOff: boolean };

type Env = Record<string, string | undefined>;

const present = (env: Env, name: string) => typeof env[name] === 'string' && env[name]!.trim() !== '';

/**
 * A PEM key put into an environment variable often arrives with its line
 * breaks written as the two characters backslash and n; the key reader needs
 * real ones.
 */
export function normalizePem(text: string): string {
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

export function bankConfig(env: Env = process.env): BankConfig {
  const switchedOff = env[BANK_ENV.enabled]?.trim() !== 'true';
  const missing = [BANK_ENV.appId, BANK_ENV.privateKey, BANK_ENV.redirectUrl].filter((name) => !present(env, name));
  if (switchedOff || missing.length > 0) return { enabled: false, credentials: null, missing, switchedOff };
  return {
    enabled: true,
    credentials: {
      appId: env[BANK_ENV.appId]!.trim(),
      privateKey: normalizePem(env[BANK_ENV.privateKey]!.trim()),
      redirectUrl: env[BANK_ENV.redirectUrl]!.trim(),
    },
    missing: [],
  };
}

/** The secret of the machine sync route, or null when it is not set (the route then refuses). */
export function bankSyncSecret(env: Env = process.env): string | null {
  return present(env, BANK_ENV.syncSecret) ? env[BANK_ENV.syncSecret]!.trim() : null;
}
