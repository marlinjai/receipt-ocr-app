'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';

/**
 * A disclosure (`<details>`) whose content is built only once it is opened, and kept after that.
 *
 * For a long list behind a closed summary: a closed `<details>` is still a full part of the page, so
 * every row is created, laid out and styled although nobody sees it. On the spending page the closed
 * table of the period's payments was 20,401 of the page's 28,435 elements (measured in production on
 * 2026-11-27). Built on the first open, the closed page carries only the summary; kept after closing,
 * a second open shows what the person left (a scroll position, an error under a row) at once.
 *
 * The price: the browser's find in page cannot reach rows that were never opened.
 *
 * Plan: docs/plans/2026-11-26-receipts-perf-pwa-ux-review.md.
 */
export default function LazyDetails({ summary, className, summaryClassName, summaryStyle, children }: { summary: ReactNode; className?: string; summaryClassName?: string; summaryStyle?: CSSProperties; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className={className} onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className={summaryClassName} style={summaryStyle}>
        {summary}
      </summary>
      {opened && children}
    </details>
  );
}
