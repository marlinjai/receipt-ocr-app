'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ComponentType } from 'react';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import { SignOutLink } from '@/app/app/spending/PushSession';
import {
  ContactsIcon,
  FinanceIcon,
  FoldIcon,
  MealsIcon,
  OverviewIcon,
  ReceiptsIcon,
  RulesIcon,
  SpendingIcon,
  ToolsIcon,
  UploadIcon,
} from '@/app/app/dashboard/dashboard-icons';
import { useNavCounts } from './nav-counts';
import { NAV_FOLD_COOKIE, NAV_FOLDED } from './nav-fold';

/**
 * The app's navigation on every page of the wide layout: the company, the one
 * main action, the places with what is open in them, and the tools apart from
 * them. Folds to icons by hand, and by itself where a table needs the width
 * (the stylesheet decides that, under `.app-nav`). The phone has its own header.
 *
 * Plan: docs/plans/2026-10-30-app-sidebar.md.
 */

interface Place {
  href: string;
  label: string;
  Icon: ComponentType;
  /** Which number stands on the place, and what it counts. */
  count?: { of: 'review' | 'meals'; what: string };
}

const PLACES: Place[] = [
  { href: '/app/overview', label: 'Überblick', Icon: OverviewIcon },
  { href: '/app/dashboard', label: 'Belege', Icon: ReceiptsIcon, count: { of: 'review', what: 'zu prüfen' } },
  { href: '/app/spending', label: 'Ausgaben', Icon: SpendingIcon },
  { href: '/app/finance', label: 'Finanzen', Icon: FinanceIcon },
  { href: '/app/meals', label: 'Bewirtung', Icon: MealsIcon, count: { of: 'meals', what: 'offen' } },
  { href: '/app/contacts', label: 'Kontakte', Icon: ContactsIcon },
  { href: '/app/rules', label: 'Regeln', Icon: RulesIcon },
];

const TOOLS: Place = { href: '/app/tools', label: 'Werkzeuge', Icon: ToolsIcon };

export default function AppSidebar({ session, logoutUrl, initialFolded }: { session: AppSession; logoutUrl: string; initialFolded: boolean }) {
  const pathname = usePathname();
  const counts = useNavCounts();
  const [folded, setFolded] = useState(initialFolded);

  const toggle = () => {
    const next = !folded;
    setFolded(next);
    document.cookie = `${NAV_FOLD_COOKIE}=${next ? NAV_FOLDED : 'open'}; path=/; max-age=31536000; samesite=lax`;
  };

  const placeLink = ({ href, label, Icon, count }: Place) => {
    const number = count && counts ? counts[count.of] : 0;
    return (
      <li key={href}>
        <Link href={href} className="app-nav-link" aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined} title={label}>
          <Icon />
          <span className="app-nav-label">{label}</span>
          {count && number > 0 && (
            <span className="app-nav-count">
              {number}
              <span className="sr-only"> {count.what}</span>
            </span>
          )}
        </Link>
      </li>
    );
  };

  return (
    <aside className="app-nav" data-folded={folded} data-theme="dark">
      <div className="app-nav-inner">
        <div className="app-nav-company">
          <WorkspaceSwitcher session={session} hideLabel />
        </div>
        <Link href="/app" className="ui-btn ui-btn-primary app-nav-upload" title="Beleg hochladen">
          <UploadIcon />
          <span className="app-nav-label">Beleg hochladen</span>
        </Link>
        <nav aria-label="Bereiche" className="app-nav-places">
          <ul>{PLACES.map(placeLink)}</ul>
          <ul className="app-nav-tools">{placeLink(TOOLS)}</ul>
        </nav>
        <div className="app-nav-foot">
          <span className="app-nav-signout">
            <SignOutLink href={logoutUrl} title={session.email}>
              Abmelden
            </SignOutLink>
          </span>
          <button type="button" className="app-nav-fold" aria-pressed={folded} aria-label="Seitenleiste einklappen" title="Seitenleiste einklappen" onClick={toggle}>
            <FoldIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
