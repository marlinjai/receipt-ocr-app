// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';

const restoreMeals = vi.fn();
vi.mock('./actions', () => ({
  restoreMeals: (...a: unknown[]) => restoreMeals(...a),
  markMealsNotMeal: vi.fn(),
  deleteMealReceipts: vi.fn(),
}));

import DismissedMeals from './DismissedMeals';

const DISMISSED = [
  meal({ rowId: 'x', vendor: 'Supermarkt Beispiel', mealType: 'not_a_meal', date: '2025-05-02', gross: 23.4 }),
  meal({ rowId: 'y', vendor: 'Kiosk Beispiel', mealType: 'not_a_meal', date: '2025-06-02', gross: 4 }),
];

function Harness({ initial }: { initial: MealRecord[] }) {
  const [list, setList] = useState(initial);
  return (
    <DismissedMeals
      records={list.filter((r) => r.mealType === 'not_a_meal')}
      onRecordsSaved={(saved) => setList((l) => l.map((r) => saved.find((s) => s.rowId === r.rowId) ?? r))}
      onRecordsRemoved={(ids) => setList((l) => l.filter((r) => !ids.includes(r.rowId)))}
    />
  );
}

beforeEach(() => restoreMeals.mockReset());
afterEach(cleanup);

describe('DismissedMeals: where "Keine Bewirtung" is undone', () => {
  it('renders nothing when no receipt is marked', () => {
    const { container } = render(<Harness initial={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists the marked receipts with their count, newest first', () => {
    render(<Harness initial={DISMISSED} />);
    expect(screen.getByText('Keine Bewirtung (2)')).toBeTruthy();
    const items = screen.getAllByRole('listitem', { hidden: true }).map((li) => li.textContent);
    expect(items[0]).toContain('02.06.2025 · Kiosk Beispiel');
    expect(items[1]).toContain('02.05.2025 · Supermarkt Beispiel');
  });

  it('"Wieder aufnehmen" takes one receipt back and says so', async () => {
    const user = userEvent.setup();
    restoreMeals.mockResolvedValue({
      ok: true,
      value: { done: ['x'], records: [{ ...DISMISSED[0], mealType: 'business_meal_external' }], skipped: [] },
    });
    render(<Harness initial={DISMISSED} />);
    await user.click(screen.getByText('Keine Bewirtung (2)'));
    await user.click(screen.getByRole('button', { name: 'Wieder aufnehmen: Supermarkt Beispiel, 02.05.2025', hidden: true }));
    const notice = await screen.findByText('„Supermarkt Beispiel“ wird wieder als Bewirtung geführt, mit den zuvor erfassten Angaben.');
    expect(restoreMeals).toHaveBeenCalledWith(['x']);
    expect(screen.getByText('Keine Bewirtung (1)')).toBeTruthy();
    expect(document.activeElement).toBe(notice);
  });

  it('taking back the last one keeps the outcome on screen', async () => {
    const user = userEvent.setup();
    restoreMeals.mockResolvedValue({
      ok: true,
      value: { done: ['x'], records: [{ ...DISMISSED[0], mealType: 'business_meal_external' }], skipped: [] },
    });
    render(<Harness initial={[DISMISSED[0]]} />);
    await user.click(screen.getByText('Keine Bewirtung (1)'));
    await user.click(screen.getByRole('button', { name: /Wieder aufnehmen/, hidden: true }));
    expect(await screen.findByText(/wird wieder als Bewirtung geführt/)).toBeTruthy();
    expect(screen.queryByText(/^Keine Bewirtung \(/)).toBeNull();
  });

  it('a failed request is an alert and the receipt stays listed', async () => {
    const user = userEvent.setup();
    restoreMeals.mockResolvedValue({ ok: false, error: 'unauthorized' });
    render(<Harness initial={DISMISSED} />);
    await user.click(screen.getByText('Keine Bewirtung (2)'));
    await user.click(screen.getByRole('button', { name: /Wieder aufnehmen: Kiosk/, hidden: true }));
    expect((await screen.findByRole('alert')).textContent).toContain('Die Anmeldung ist abgelaufen');
    expect(screen.getByText('Keine Bewirtung (2)')).toBeTruthy();
  });
});
