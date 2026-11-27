// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { receiptLinked } from '@/app/app/spending/open-checks';

const pathname = vi.hoisted(() => ({ value: '/app/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
const getNavCounts = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts }));

import Refusals from '@/components/Refusals';
import { AppStoreProvider, NAV_COUNTS_FRESH_MS, RefusalDeskProvider, useAppStore } from '../provider';
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

describe('the numbers of the navigation when the page changes', () => {
  /** The provider on a page; `rerender` with another path is a click in the navigation. */
  function onPage(path: string) {
    pathname.value = path;
    let app: AppStore | null = null;
    const Seen = () => {
      app = useAppStore();
      return null;
    };
    const tree = () => (
      <AppStoreProvider company="Alpha">
        <Seen />
      </AppStoreProvider>
    );
    const view = render(tree());
    return {
      app: () => app as unknown as AppStore,
      go: async (next: string) => {
        pathname.value = next;
        view.rerender(tree());
        await act(async () => {});
      },
    };
  }

  beforeEach(() => getNavCounts.mockClear());

  afterEach(() => {
    vi.useRealTimers();
    getNavCounts.mockReset();
    getNavCounts.mockImplementation(async () => ({ ok: false }));
    pathname.value = '/app/spending';
  });

  it('asks once, not on every click, while the answer is fresh; after a minute it asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    getNavCounts.mockImplementation(async () => ({ ok: true, value: { review: 4, meals: 2 } }) as never);
    const page = onPage('/app/spending');
    await act(async () => {});
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    expect(page.app().counts).toEqual({ review: 4, meals: 2 });

    for (const next of ['/app/finance', '/app/contacts', '/app/rules', '/app/tools']) await page.go(next);
    expect(getNavCounts).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + NAV_COUNTS_FRESH_MS));
    await page.go('/app/finance');
    expect(getNavCounts).toHaveBeenCalledTimes(2);
  });

  it('an answer that arrives after the next click still shows, and that click does not ask again', async () => {
    let answer: (value: unknown) => void = () => {};
    getNavCounts.mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    const page = onPage('/app/spending');
    await page.go('/app/finance');
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, value: { review: 1, meals: 7 } }));
    expect(page.app().counts).toEqual({ review: 1, meals: 7 });
  });

  it('a failed answer has the next page ask again, so a number never stays missing for a minute', async () => {
    getNavCounts.mockImplementation(async () => ({ ok: false }));
    const page = onPage('/app/spending');
    await act(async () => {});
    await page.go('/app/finance');
    expect(getNavCounts).toHaveBeenCalledTimes(2);
    getNavCounts.mockImplementation(async () => {
      throw new Error('offline');
    });
    await page.go('/app/rules');
    await page.go('/app/tools');
    expect(getNavCounts).toHaveBeenCalledTimes(4);
  });

  it('leaving the dashboard hands its own numbers over, so the next page does not ask', async () => {
    const page = onPage('/app/dashboard');
    await act(async () => {});
    expect(getNavCounts).not.toHaveBeenCalled();
    const close = page.app().openReceipts({ reviewCount: 5, openMeals: 9 } as unknown as ReceiptsStore);
    close();
    await page.go('/app/spending');
    expect(getNavCounts).not.toHaveBeenCalled();
    expect(page.app().counts).toEqual({ review: 5, meals: 9 });
  });

  it('an answer asked before the receipts page handed over its numbers does not overwrite them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    let answer: (value: unknown) => void = () => {};
    getNavCounts.mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    const page = onPage('/app/spending');
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    await page.go('/app/dashboard');
    vi.setSystemTime(new Date(Date.now() + 1000));
    const close = page.app().openReceipts({ reviewCount: 2, openMeals: 3 } as unknown as ReceiptsStore);
    close();
    await page.go('/app/finance');
    await act(async () => answer({ ok: true, value: { review: 6, meals: 3 } }));
    expect(page.app().counts).toEqual({ review: 2, meals: 3 });
  });

  it('a receipt saved on the upload page has the next page ask, however fresh the numbers were', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    getNavCounts.mockImplementation(async () => ({ ok: true, value: { review: 1, meals: 0 } }) as never);
    const page = onPage('/app/spending');
    await act(async () => {});
    await page.go('/app');
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + 2000));
    page.app().countsChanged();
    await page.go('/app/finance');
    expect(getNavCounts).toHaveBeenCalledTimes(2);
    // And only once: the answer makes them fresh again.
    vi.setSystemTime(new Date(Date.now() + 2000));
    await page.go('/app/rules');
    expect(getNavCounts).toHaveBeenCalledTimes(2);
  });

  it('a receipt saved while an ask is still on its way has the next page ask again, in the same millisecond too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    let answer: (value: unknown) => void = () => {};
    getNavCounts.mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    const page = onPage('/app/spending');
    expect(getNavCounts).toHaveBeenCalledTimes(1);
    await page.go('/app');
    page.app().countsChanged();
    await act(async () => answer({ ok: true, value: { review: 1, meals: 0 } }));
    await page.go('/app/finance');
    expect(getNavCounts).toHaveBeenCalledTimes(2);
  });
});
