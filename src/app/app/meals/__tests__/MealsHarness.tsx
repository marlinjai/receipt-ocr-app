import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Refusals from '@/components/Refusals';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { AppStore } from '@/stores/AppStore';
import { MealsStore } from '@/stores/MealsStore';
import { AppStoreContext } from '@/stores/provider';

/** A tab with what `MealsClient` gives it: the page's store, opened on the app's store, and the shell's refusals. */
export const MealsHarness = observer(function MealsHarness({
  initial,
  settings,
  children,
}: {
  initial: MealRecord[];
  settings: MealTaxSettings;
  children: (store: MealsStore, focusHome: RefObject<HTMLElement | null>) => ReactNode;
}) {
  const [app] = useState(() => new AppStore());
  const [store] = useState(() => new MealsStore({ records: initial, contacts: [], settings, defaultHost: '', readAt: 0 }, app.mealOutbox));
  useEffect(() => app.openMeals(store), [app, store]);
  const focusHome = useRef<HTMLHeadingElement>(null);
  return (
    <AppStoreContext.Provider value={app}>
      <h1 ref={focusHome} tabIndex={-1}>
        Bewirtungsverzeichnis
      </h1>
      {children(store, focusHome)}
      <Refusals />
    </AppStoreContext.Provider>
  );
});
