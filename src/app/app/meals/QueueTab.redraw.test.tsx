// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SMALL_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import { incompleteQueue } from '@/lib/meals/register';
import type { MealRecord } from '@/lib/meals/types';

const drawn = vi.hoisted(() => ({ days: [] as string[] }));
vi.mock('@/lib/meals/messages', async (original) => {
  const real = await original<typeof import('@/lib/meals/messages')>();
  return {
    ...real,
    formatDay: (day: string) => {
      drawn.days.push(day);
      return real.formatDay(day);
    },
  };
});
vi.mock('./actions', () => ({ markMealsNotMeal: vi.fn(), deleteMealReceipts: vi.fn(), restoreMeals: vi.fn() }));
vi.mock('./MealEditor', () => ({ default: () => null }));

import { MealsStore } from '@/stores/MealsStore';
import QueueTab from './QueueTab';

afterEach(cleanup);

describe('reclassifying one meal', () => {
  it('redraws its row and leaves the other rows alone', () => {
    const first = meal({ rowId: 'a', date: '2026-01-01', occasion: '' });
    const second = meal({ rowId: 'b', date: '2026-02-02', occasion: '' });
    const third = meal({ rowId: 'c', date: '2026-03-03', occasion: '' });
    const queue = (records: MealRecord[]) => incompleteQueue(records);
    const writes = new MealsStore({ records: [], contacts: [], settings: SMALL_BUSINESS, defaultHost: '', readAt: 0 });
    const tab = (records: MealRecord[]) => (
      <QueueTab queue={queue(records)} contacts={[]} settings={SMALL_BUSINESS} defaultHost="" onRecordSaved={vi.fn()} onRecordsSaved={vi.fn()} writes={writes} focusHome={{ current: null }} onContactCreated={vi.fn()} onOpenRegister={vi.fn()} onUnsavedChange={vi.fn()} />
    );
    const { rerender } = render(tab([first, second, third]));
    drawn.days.length = 0;
    rerender(tab([first, second, { ...third, place: 'Neu' }]));
    expect(new Set(drawn.days).has('2026-01-01')).toBe(false);
    expect(new Set(drawn.days).has('2026-03-03')).toBe(true);
  });
});
