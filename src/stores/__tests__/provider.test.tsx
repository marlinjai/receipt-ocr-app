// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { receiptLinked } from '@/app/app/spending/open-checks';

vi.mock('next/navigation', () => ({ usePathname: () => '/app/spending' }));
const getNavCounts = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts }));

import { AppStoreProvider, useAppStore } from '../provider';
import type { MealTaxSettings } from '@/lib/meals/types';
import type { AppStore } from '../AppStore';
import { MealsStore } from '../MealsStore';

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
      <AppStoreProvider>
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
      <AppStoreProvider>
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
      <AppStoreProvider>
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
