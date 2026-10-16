import { describe, expect, it } from 'vitest';
import { berlinYear, safeMonth, safeYear } from '../period';

describe('period', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it("takes the year in the owner's time zone, also around New Year", () => {
    expect(berlinYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(berlinYear(new Date('2026-12-31T22:30:00Z'))).toBe(2026);
  });

  it('accepts sensible years and falls back to the current one otherwise', () => {
    expect(safeYear(2025, now)).toBe(2025);
    expect(safeYear('2027', now)).toBe(2027);
    expect(safeYear(2028, now)).toBe(2026);
    expect(safeYear(1999, now)).toBe(2026);
    expect(safeYear('abc', now)).toBe(2026);
    expect(safeYear(null, now)).toBe(2026);
    expect(safeYear(2025.5, now)).toBe(2026);
  });

  it('accepts months 1 to 12 and reads anything else as the whole year', () => {
    expect(safeMonth(1)).toBe(1);
    expect(safeMonth('12')).toBe(12);
    expect(safeMonth(0)).toBeNull();
    expect(safeMonth(13)).toBeNull();
    expect(safeMonth(null)).toBeNull();
    expect(safeMonth('')).toBeNull();
    expect(safeMonth('x')).toBeNull();
  });
});
