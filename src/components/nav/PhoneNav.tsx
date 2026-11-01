'use client';

import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { useAppStore } from '@/stores/provider';
import BottomSheet from '@/components/ui/BottomSheet';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import { SignOutLink } from '@/app/app/spending/PushSession';
import { BellIcon, MoreIcon, UploadIcon } from '@/app/app/dashboard/dashboard-icons';
import { isCurrentPlace, NOTIFICATION_SETTINGS_HREF, PLACES, TOOLS, type Place } from './nav-places';

/**
 * The app's navigation on a phone: what the sidebar is on the wide layout. The
 * bar is always in the thumb's reach and holds the three places a phone is used
 * for and the upload between them; "Mehr" opens a sheet with every place, in the
 * sidebar's order and with its numbers, the company, the notification settings
 * and signing out, so nothing can only be reached from one particular page.
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md, section "The phone's navigation".
 */

const BAR_HREFS = ['/app/dashboard', '/app/spending', '/app/finance'];

const PhoneNav = observer(function PhoneNav({ session, logoutUrl }: { session: AppSession; logoutUrl: string }) {
  const pathname = usePathname();
  const { counts } = useAppStore();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The browser's way back changes the page too: the sheet goes with the old one.
  const [sheetPath, setSheetPath] = useState(pathname);
  if (sheetPath !== pathname) {
    setSheetPath(pathname);
    setSheetOpen(false);
  }

  const numberOn = (place: Place) => (place.count && counts ? counts[place.count.of] : 0);
  const count = (place: Place, className: string) => {
    const number = numberOn(place);
    return (
      place.count &&
      number > 0 && (
        <span className={className}>
          {number}
          <span className="sr-only"> {place.count.what}</span>
        </span>
      )
    );
  };

  const onBar = PLACES.filter((p) => BAR_HREFS.includes(p.href));
  const [first, ...rest] = onBar;
  // Whatever waits behind "Mehr" shows on it, so an open meal is not hidden by being a tap away.
  const waitingBehindMore = PLACES.filter((p) => !BAR_HREFS.includes(p.href)).reduce((sum, p) => sum + numberOn(p), 0);
  const elsewhere = !BAR_HREFS.some((href) => isCurrentPlace(pathname, href)) && pathname !== '/app';

  const barLink = (place: Place) => (
    <li key={place.href}>
      <Link
        href={place.href}
        className="phone-nav-link"
        aria-current={isCurrentPlace(pathname, place.href) ? 'page' : undefined}
        aria-label={place.count && numberOn(place) > 0 ? `${place.label}, ${numberOn(place)} ${place.count.what}` : undefined}
      >
        <span className="phone-nav-icon">
          <place.Icon />
          {count(place, 'phone-nav-count')}
        </span>
        {place.label}
      </Link>
    </li>
  );

  const sheetLink = (place: Place) => (
    <li key={place.href}>
      <Link href={place.href} className="app-nav-link" aria-current={isCurrentPlace(pathname, place.href) ? 'page' : undefined} onClick={() => setSheetOpen(false)}>
        <place.Icon />
        <span className="app-nav-label">{place.label}</span>
        {count(place, 'app-nav-count')}
      </Link>
    </li>
  );

  return (
    <>
      <nav className="phone-nav" aria-label="Hauptbereiche" data-theme="dark">
        <ul>
          {barLink(first)}
          {barLink(rest[0])}
          <li>
            <Link href="/app" className="phone-nav-link phone-nav-upload" aria-current={pathname === '/app' ? 'page' : undefined}>
              <span className="phone-nav-icon">
                <UploadIcon />
              </span>
              Hochladen
            </Link>
          </li>
          {barLink(rest[1])}
          <li>
            <button type="button" className="phone-nav-link" aria-haspopup="dialog" aria-expanded={sheetOpen} aria-label={waitingBehindMore > 0 ? `Mehr, ${waitingBehindMore} offen` : 'Mehr'} data-current={elsewhere} onClick={() => setSheetOpen(true)}>
              <span className="phone-nav-icon">
                <MoreIcon />
                {waitingBehindMore > 0 && <span className="phone-nav-count">{waitingBehindMore}</span>}
              </span>
              Mehr
            </button>
          </li>
        </ul>
      </nav>
      <BottomSheet open={sheetOpen} title="Alle Bereiche" onClose={() => setSheetOpen(false)}>
        <div className="phone-sheet">
          <WorkspaceSwitcher session={session} />
          <nav aria-label="Alle Bereiche">
            <ul>
              {PLACES.map(sheetLink)}
              {sheetLink(TOOLS)}
            </ul>
          </nav>
          <div className="phone-sheet-foot">
            <Link href={NOTIFICATION_SETTINGS_HREF} className="app-nav-link" onClick={() => setSheetOpen(false)}>
              <BellIcon />
              <span className="app-nav-label">Benachrichtigungen</span>
            </Link>
            <span className="phone-sheet-signout">
              <SignOutLink href={logoutUrl} title={session.email}>
                Abmelden
              </SignOutLink>
            </span>
          </div>
        </div>
      </BottomSheet>
    </>
  );
});

export default PhoneNav;
