// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { receiptLinked } from '@/app/app/spending/open-checks';

vi.mock('next/navigation', () => ({ usePathname: () => '/app/spending' }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: async () => ({ ok: false }) }));

import { AppStoreProvider, useAppStore } from '../provider';
import type { AppStore } from '../AppStore';

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
});
