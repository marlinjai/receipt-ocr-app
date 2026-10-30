'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { AiIcon, ContactsIcon, ExportIcon, FinanceIcon, MealsIcon, OverviewIcon, RulesIcon, ToolsIcon } from './dashboard-icons';

/**
 * The dashboard's actions on a phone, where the sidebar of the wide layout is
 * not shown. Upload stays in reach and everything else opens below the title
 * as a two-column menu, in the page's flow (no popover to clip or to position).
 * Same places as the sidebar; "Ausgaben" stands in the phone header.
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */
export default function DashboardPhoneActions({
  title,
  openMealCount,
  onExport,
  onToggleAi,
}: {
  /** The table's name, the page heading. */
  title: string;
  openMealCount: number;
  onExport: () => void;
  onToggleAi: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  return (
    <div className="mb-1 sm:hidden">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto min-w-0 truncate text-2xl font-bold" style={{ color: 'var(--dt-text-primary)' }}>
          {title}
        </h1>
        <Link href="/app" className="ui-btn ui-btn-primary">
          + Hochladen
        </Link>
        <button type="button" className="ui-btn" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>
          Mehr
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="transition-transform duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
          >
            <polyline points="4 6 8 10 12 6" />
          </svg>
        </button>
      </div>
      {open && (
        <nav id={menuId} aria-label="Weitere Bereiche und Aktionen" className="ui-panel-in mt-3">
          <div className="grid grid-cols-2 gap-2">
            <Link href="/app/overview" className="ui-btn ui-btn-start">
              <OverviewIcon />
              Überblick
            </Link>
            <Link href="/app/finance" className="ui-btn ui-btn-start">
              <FinanceIcon />
              Finanzen
            </Link>
            <Link href="/app/meals" className="ui-btn ui-btn-start">
              <MealsIcon />
              Bewirtung
              {openMealCount > 0 && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                  style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
                >
                  {openMealCount}
                  <span className="sr-only"> offen</span>
                </span>
              )}
            </Link>
            <Link href="/app/contacts" className="ui-btn ui-btn-start">
              <ContactsIcon />
              Kontakte
            </Link>
            <button
              type="button"
              className="ui-btn ui-btn-start"
              onClick={() => {
                onExport();
                setOpen(false);
              }}
            >
              <ExportIcon />
              Als CSV exportieren
            </button>
            <Link href="/app/rules" className="ui-btn ui-btn-start">
              <RulesIcon />
              Regeln
            </Link>
            <Link href="/app/tools" className="ui-btn ui-btn-start">
              <ToolsIcon />
              Werkzeuge
            </Link>
            <button
              type="button"
              className="ui-btn ui-btn-start"
              onClick={() => {
                onToggleAi();
                setOpen(false);
              }}
            >
              <AiIcon />
              Assistent
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
