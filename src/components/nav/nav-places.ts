import type { ComponentType } from 'react';
import {
  ContactsIcon,
  FinanceIcon,
  MealsIcon,
  OverviewIcon,
  ReceiptsIcon,
  RulesIcon,
  SpendingIcon,
  ToolsIcon,
} from '@/app/app/dashboard/dashboard-icons';

/** The app's places, the same on the wide sidebar and on the phone. */
export interface Place {
  href: string;
  label: string;
  Icon: ComponentType;
  /** Which number stands on the place, and what it counts. */
  count?: { of: 'review' | 'meals'; what: string };
}

export const PLACES: Place[] = [
  { href: '/app/overview', label: 'Überblick', Icon: OverviewIcon },
  { href: '/app/dashboard', label: 'Belege', Icon: ReceiptsIcon, count: { of: 'review', what: 'zu prüfen' } },
  { href: '/app/spending', label: 'Ausgaben', Icon: SpendingIcon },
  { href: '/app/finance', label: 'Finanzen', Icon: FinanceIcon },
  { href: '/app/meals', label: 'Bewirtung', Icon: MealsIcon, count: { of: 'meals', what: 'offen' } },
  { href: '/app/contacts', label: 'Kontakte', Icon: ContactsIcon },
  { href: '/app/rules', label: 'Regeln', Icon: RulesIcon },
];

export const TOOLS: Place = { href: '/app/tools', label: 'Werkzeuge', Icon: ToolsIcon };

/** Where a phone's "Mehr" sheet opens the notification settings: under the receipt checks of the spending page. */
export const NOTIFICATION_SETTINGS_HREF = '/app/spending?ansicht=belege&einstellung=benachrichtigung';

export function isCurrentPlace(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
