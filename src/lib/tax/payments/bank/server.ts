import 'server-only';
import { getFxRate } from '@/lib/fx-rates';
import { createBankClient } from './client';
import { bankConfig } from './config';
import type { BankDeps } from './service';

/** How long a reference rate may take (a rate the cache lacks is fetched once); after that the movement waits for the next fetch. */
const FX_TIMEOUT_MS = 10_000;

/** The receipts' reference rate cache, never waiting longer than `FX_TIMEOUT_MS`. */
function fxRate(currency: string, day: string): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FX_TIMEOUT_MS);
    timer.unref?.();
    getFxRate(currency, day).then(
      (rate) => {
        clearTimeout(timer);
        resolve(rate);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The interface as this server is configured, or null when the bank feed is off. */
export function serverBankDeps(): BankDeps | null {
  const config = bankConfig();
  if (!config.enabled) return null;
  return { api: createBankClient(config.credentials), redirectUrl: config.credentials.redirectUrl, fxRate };
}
