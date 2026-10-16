/** The period a request asks for, cleaned. Pure. */

/** The calendar year in the owner's time zone: on a server in another zone the year changes at a different moment. */
export function berlinYear(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(now));
}

/** A year a person can sensibly ask for; anything else falls back to the current year. */
export function safeYear(year: unknown, now: Date = new Date()): number {
  const n = typeof year === 'number' ? year : Number(year);
  const current = berlinYear(now);
  return Number.isInteger(n) && n >= 2000 && n <= current + 1 ? n : current;
}

/** 1 to 12, or null for the whole year. */
export function safeMonth(month: unknown): number | null {
  if (month === null || month === undefined || month === '') return null;
  const n = typeof month === 'number' ? month : Number(month);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
