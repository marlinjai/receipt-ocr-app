// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { receiptLinked } from '@/app/app/spending/open-checks';

const pathname = vi.hoisted(() => ({ value: '/app/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
const getNavCounts = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts }));

import Refusals from '@/components/Refusals';
import { AppStoreProvider, RefusalDeskProvider, useAppStore } from '../provider';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import type { AppStore } from '../AppStore';
import { MealsStore } from '../MealsStore';
import type { ReceiptsStore } from '../ReceiptsStore';

afterEach(cleanup);

const leave = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('closing the page', () => {
  it('asks first only while an answer of the receipt checks is on its way', () => {
    let app: AppStore | null = null;
    const Seen = () => {
      app = useAppStore();
      return null;
    };
    const { unmount } = render(
      <AppStoreProvider company="Alpha">
        <Seen />
      </AppStoreProvider>,
    );
    const outbox = (app as unknown as AppStore).checkOutbox;
    expect(leave()).toBe(false);
    const write = outbox.begin('p', receiptLinked, 'r');
    expect(leave()).toBe(true);
    outbox.refuse(write);
    expect(leave()).toBe(false);
    outbox.begin('p', receiptLinked, 'r');
    unmount();
    expect(leave()).toBe(false);
  });

  it('asks first too while a list action of the meals page is on its way', () => {
    let app: AppStore | null = null;
    const Seen = () => {
      app = useAppStore();
      return null;
    };
    render(
      <AppStoreProvider company="Alpha">
        <Seen />
      </AppStoreProvider>,
    );
    const outbox = (app as unknown as AppStore).mealOutbox;
    const write = outbox.begin('delete', ['a']);
    expect(leave()).toBe(true);
    outbox.end(write);
    expect(leave()).toBe(false);
  });
});

describe('a list action of the meals page that ends after the page closed', () => {
  it('has the navigation ask the server again; with the page open its number needs no asking', async () => {
    let app: AppStore | null = null;
    const Seen = () => {
      app = useAppStore();
      return null;
    };
    render(
      <AppStoreProvider company="Alpha">
        <Seen />
      </AppStoreProvider>,
    );
    const store = app as unknown as AppStore;
    const asked = getNavCounts.mock.calls.length;
    store.mealOutbox.end(store.mealOutbox.begin('delete', ['a']));
    expect(getNavCounts.mock.calls.length).toBe(asked + 1);

    const close = store.openMeals(new MealsStore({ records: [], contacts: [], settings: {} as MealTaxSettings, defaultHost: '', readAt: 0 }, store.mealOutbox));
    store.mealOutbox.end(store.mealOutbox.begin('delete', ['a']));
    expect(getNavCounts.mock.calls.length).toBe(asked + 1);
    close();
  });
});

describe('a meal write ending on the dashboard', () => {
  it('has the store of the dashboard count again, because its number is the one on screen', () => {
    pathname.value = '/app/dashboard';
    let app: AppStore | null = null;
    const Seen = () => {
      app = useAppStore();
      return null;
    };
    render(
      <AppStoreProvider company="Alpha">
        <Seen />
      </AppStoreProvider>,
    );
    const store = app as unknown as AppStore;
    const askOpenMeals = vi.fn();
    const close = store.openReceipts({ reviewCount: 0, openMeals: 3, askOpenMeals } as unknown as ReceiptsStore);
    store.mealOutbox.end(store.mealOutbox.begin('delete', ['a']));
    expect(askOpenMeals).toHaveBeenCalledTimes(1);
    close();
    pathname.value = '/app/spending';
  });
});

describe('a refusal and a company switch', () => {
  /** The layout: the desk above the provider the company keys. */
  function shell(company: string, seen: (app: AppStore) => void) {
    const Seen = () => {
      seen(useAppStore());
      return null;
    };
    return (
      <RefusalDeskProvider>
        <AppStoreProvider key={company} company={company}>
          <Seen />
          <Refusals />
        </AppStoreProvider>
      </RefusalDeskProvider>
    );
  }

  const meals = (app: AppStore, rowId: string) => {
    const store = new MealsStore({ records: [{ rowId, mealType: 'business_meal_external' } as MealRecord], contacts: [], settings: {} as MealTaxSettings, defaultHost: '', readAt: 0 }, app.mealOutbox);
    return { store, write: store.begin('delete', [rowId])! };
  };

  it('a meal refused after the switch reaches the person, named after its company', () => {
    let first = null as unknown as AppStore;
    const { rerender } = render(shell('Alpha', (app) => (first = app)));
    const { store, write } = meals(first, 'a');
    let second = null as unknown as AppStore;
    rerender(shell('Beta', (app) => (second = app)));
    act(() => store.refused(write, 'Lokal A', 'Dafür fehlt die Berechtigung.'));
    expect(screen.getByRole('alert').textContent).toBe('Firma Alpha: Lokal A: Dafür fehlt die Berechtigung.');
    // It is no refusal of the company on screen, and closing it ends it.
    expect(second.looseRefusals).toEqual([]);
    act(() => screen.getByRole('button', { name: 'Hinweis schließen' }).click());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a check refused after the switch does too', () => {
    let first = null as unknown as AppStore;
    const { rerender } = render(shell('Alpha', (app) => (first = app)));
    rerender(shell('Beta', () => {}));
    act(() => first.checkOutbox.say('check:p', 'Zahlung Beispiel', 'Nicht geklappt.'));
    expect(screen.getByRole('alert').textContent).toBe('Firma Alpha: Zahlung Beispiel: Nicht geklappt.');
  });

  it('what was refused before the switch and not closed goes along, named too, for both kinds', () => {
    let first = null as unknown as AppStore;
    const { rerender } = render(shell('Alpha', (app) => (first = app)));
    const { store, write } = meals(first, 'a');
    act(() => {
      store.refused(write, 'Lokal A', 'Eins.');
      first.checkOutbox.say('run', null, 'Zwei.');
    });
    rerender(shell('Beta', () => {}));
    expect(screen.getAllByRole('alert').map((a) => a.textContent).sort()).toEqual(['Firma Alpha: Lokal A: Eins.', 'Firma Alpha: Zwei.']);
  });

  it('coming back to the company still names it, and a refusal of the company on screen reads as ever', () => {
    let first = null as unknown as AppStore;
    const { rerender } = render(shell('Alpha', (app) => (first = app)));
    const { store, write } = meals(first, 'a');
    rerender(shell('Beta', () => {}));
    act(() => store.refused(write, null, 'Eins.'));
    let back = null as unknown as AppStore;
    rerender(shell('Alpha', (app) => (back = app)));
    act(() => back.checkOutbox.say('run', null, 'Zwei.'));
    expect(screen.getAllByRole('alert').map((a) => a.textContent).sort()).toEqual(['Firma Alpha: Eins.', 'Zwei.']);
  });
});
