import 'server-only';
import { createBankClient } from './client';
import { bankConfig } from './config';
import type { BankDeps } from './service';

/** The interface as this server is configured, or null when the bank feed is off. */
export function serverBankDeps(): BankDeps | null {
  const config = bankConfig();
  if (!config.enabled) return null;
  return { api: createBankClient(config.credentials), redirectUrl: config.credentials.redirectUrl };
}
