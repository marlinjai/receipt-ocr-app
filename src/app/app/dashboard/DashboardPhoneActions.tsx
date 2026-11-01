'use client';

import { useId, useState } from 'react';
import { AiIcon, ExportIcon } from './dashboard-icons';

/**
 * What the dashboard itself can do on a phone. The places and the upload are in
 * the bottom bar (`PhoneNav`); here stand only the two actions that work on what
 * this page shows, directly beside its title, in the page's flow.
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */
export default function DashboardPhoneActions({
  title,
  onExport,
  onToggleAi,
}: {
  /** The table's name, the page heading. */
  title: string;
  onExport: () => void;
  onToggleAi: () => void;
}) {
  return (
    <div className="mb-1 flex items-center gap-2 sm:hidden">
      <h1 className="mr-auto min-w-0 truncate text-2xl font-bold" style={{ color: 'var(--dt-text-primary)' }}>
        {title}
      </h1>
      <button type="button" className="ui-btn" aria-label="Als CSV exportieren" onClick={onExport}>
        <ExportIcon />
        CSV
      </button>
      <button type="button" className="ui-btn" onClick={onToggleAi}>
        <AiIcon />
        Assistent
      </button>
    </div>
  );
}
