'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BROWSER_RULES_IMPORTED_KEY, BROWSER_RULES_KEY, parseBrowserRules } from '@/lib/classification-rules';
import { importBrowserRules } from '@/app/app/rules-actions';

/**
 * The one-time move of classification rules that an earlier version kept in
 * this browser's local storage. They go to the company active now; the old
 * entry is renamed (not deleted) only after the server took them, so a failed
 * move is tried again on the next page and nothing is lost. Says what it did.
 */
export default function BrowserRulesImport() {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(BROWSER_RULES_KEY);
    } catch {
      return;
    }
    const rules = parseBrowserRules(raw);
    if (raw === null) return;
    let cancelled = false;
    void (async () => {
      const res = rules.length > 0 ? await importBrowserRules(rules) : null;
      if (cancelled || (res && !res.ok)) return;
      try {
        localStorage.setItem(BROWSER_RULES_IMPORTED_KEY, raw as string);
        localStorage.removeItem(BROWSER_RULES_KEY);
      } catch {
        // Storage refused the write: the import is repeat-safe, the next page tries again.
      }
      if (res && res.ok && res.value.imported > 0) {
        const company = res.value.companyLabel ? ` der Firma ${res.value.companyLabel}` : '';
        setNote(
          `${res.value.imported === 1 ? '1 Zuordnungsregel aus diesem Browser gilt' : `${res.value.imported} Zuordnungsregeln aus diesem Browser gelten`} jetzt für alle Belege${company}.`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!note) return null;
  return (
    <div className="ui-note ui-note-ok relative z-20 mx-4 mt-3 flex flex-wrap items-center gap-3" role="status">
      <span>{note}</span>
      <Link href="/app/rules" className="underline">Regeln ansehen</Link>
      <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setNote(null)}>
        Schließen
      </button>
    </div>
  );
}
