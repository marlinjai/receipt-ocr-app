'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import FxRecomputePanel from './FxRecomputePanel';
import { AiIcon, ContactsIcon, ExportIcon, FinanceIcon, ImportIcon, MealsIcon, OverviewIcon } from './dashboard-icons';

/**
 * The dashboard's actions on a phone. The wide layout lines up nine buttons in
 * one row; on a phone that row was three screens wide and pushed the whole page
 * sideways. Here upload stays in reach and everything else opens below the
 * title as a two-column menu, in the page's flow (no popover to clip or to
 * position). The wide title row is hidden on a phone; this one takes its place. Same destinations, same labels as the wide row.
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */
export default function DashboardPhoneActions({
  title,
  openMealCount,
  aiOpen,
  onExport,
  onToggleAi,
}: {
  /** The table's name, the page heading. */
  title: string;
  openMealCount: number;
  aiOpen: boolean;
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
            className="transition-transform duration-150 ease-out"
            style={{ transform: open ? 'rotate(180deg)' : undefined }}
          >
            <polyline points="4 6 8 10 12 6" />
          </svg>
        </button>
      </div>
      {open && (
        <nav id={menuId} aria-label="Weitere Bereiche und Aktionen" className="ui-panel-in mt-3">
          <div className="grid grid-cols-2 gap-2">
            <Link href="/app/overview" className="ui-btn justify-start">
              <OverviewIcon />
              Overview
            </Link>
            <Link href="/app/finance" className="ui-btn justify-start">
              <FinanceIcon />
              Finanzen
            </Link>
            <Link href="/app/meals" className="ui-btn justify-start">
              <MealsIcon />
              Bewirtung
              {openMealCount > 0 && (
                <span
                  className="rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                  style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
                  aria-label={`${openMealCount} offen`}
                >
                  {openMealCount}
                </span>
              )}
            </Link>
            <Link href="/app/contacts" className="ui-btn justify-start">
              <ContactsIcon />
              Kontakte
            </Link>
            <button
              type="button"
              className="ui-btn justify-start"
              onClick={() => {
                onExport();
                setOpen(false);
              }}
            >
              <ExportIcon />
              Export CSV
            </button>
            <Link href="/app/import" className="ui-btn justify-start">
              <ImportIcon />
              Import
            </Link>
            <button
              type="button"
              className="ui-btn justify-start"
              aria-pressed={aiOpen}
              onClick={() => {
                onToggleAi();
                setOpen(false);
              }}
            >
              <AiIcon />
              AI
            </button>
            <FxRecomputePanel />
          </div>
        </nav>
      )}
    </div>
  );
}
