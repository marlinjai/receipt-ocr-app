import { prisma } from '@/lib/prisma';

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';

interface FrankfurterResponse {
  rates?: Record<string, number>;
}

/**
 * Historical ECB reference rate for `currency` -> EUR on `isoDate`, cached in the
 * `fx_rates` table so the same currency/date pair is never fetched twice.
 *
 * Returns null (never a guessed default) when the rate can't be determined, so a
 * failure shows up as a visibly blank cell rather than a silently wrong total.
 * `recomputeFxRates` (src/app/app/actions.ts) is the manual retry path for these.
 */
export async function getFxRate(currency: string, isoDate: string | null): Promise<number | null> {
  if (currency === 'EUR') return 1;
  if (!isoDate) {
    console.error(`[fx-rates] no invoice date available, cannot look up ${currency} -> EUR rate`);
    return null;
  }

  const date = isoDate.slice(0, 10);

  const cached = await prisma.fxRate.findUnique({ where: { date_currency: { date, currency } } });
  if (cached) return cached.rate;

  const rate = await fetchFxRate(currency, date);
  if (rate === null) return null;

  await prisma.fxRate.upsert({
    where: { date_currency: { date, currency } },
    create: { date, currency, rate },
    update: { rate },
  });
  return rate;
}

async function fetchFxRate(currency: string, date: string): Promise<number | null> {
  const url = `${FRANKFURTER_BASE}/${date}?from=${currency}&to=EUR`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[fx-rates] frankfurter.dev request failed for ${currency} on ${date}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as FrankfurterResponse;
    const rate = data.rates?.EUR;
    if (typeof rate !== 'number') {
      console.error(`[fx-rates] no EUR rate in frankfurter.dev response for ${currency} on ${date}`);
      return null;
    }
    return rate;
  } catch (err) {
    console.error(`[fx-rates] frankfurter.dev request threw for ${currency} on ${date}:`, err);
    return null;
  }
}
