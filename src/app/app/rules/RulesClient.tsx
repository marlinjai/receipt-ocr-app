'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ClassificationRule, RuleErrorCode, RuleType } from '@/lib/classification-rules';
import { CATEGORY_OPTIONS, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { deleteClassificationRule, listClassificationRules, saveClassificationRule } from '../rules-actions';

interface Loaded {
  rules: ClassificationRule[];
  companyLabel: string | null;
}

const TYPE_LABELS: Record<RuleType, string> = {
  vendor: 'Anbieter enthält',
  keyword: 'Belegtext enthält',
  freetext: 'Hinweis für den Assistenten',
};

const ERROR_TEXT: Record<RuleErrorCode | 'failed', string> = {
  invalid_type: 'Bitte eine Art der Regel wählen.',
  match_value_required: 'Bitte angeben, worauf die Regel passt.',
  match_value_too_long: 'Der Text ist zu lang (höchstens 300 Zeichen).',
  invalid_zuordnung: 'Bitte eine Zuordnung wählen.',
  invalid_category: 'Diese Kategorie gibt es nicht.',
  failed: 'Das hat nicht geklappt. Bitte erneut versuchen oder die Seite neu laden.',
};

/**
 * The classification rules of the active company. A vendor or text rule sets
 * the assignment (and the category, when given) of every receipt read from now
 * on; a hint only reaches the chat assistant. Receipts already stored are not
 * changed by a new rule.
 */
export default function RulesClient({ initial }: { initial: Loaded | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(initial);
  const [type, setType] = useState<RuleType>('vendor');
  const [matchValue, setMatchValue] = useState('');
  const [zuordnung, setZuordnung] = useState(ZUORDNUNG_OPTIONS[1] ?? '');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const res = await listClassificationRules();
    if (res.ok) setLoaded(res.value);
    else setError(ERROR_TEXT.failed);
  };

  if (!loaded) {
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center px-4 py-16">
        <div className="glass-panel max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>Die Regeln konnten nicht geladen werden</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>Bitte die Seite neu laden oder neu anmelden.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/app/rules" className="ui-btn ui-btn-primary">Neu laden</Link>
            <Link href="/app/dashboard" className="ui-btn">Zum Dashboard</Link>
          </div>
        </div>
      </main>
    );
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await saveClassificationRule({ type, matchValue, zuordnung, categoryOverride: category || null });
    setBusy(false);
    if (!res.ok) {
      setError(ERROR_TEXT[res.error]);
      return;
    }
    setMatchValue('');
    setCategory('');
    await reload();
  };

  const remove = async (rule: ClassificationRule) => {
    setBusy(true);
    setError(null);
    const res = await deleteClassificationRule(rule.id);
    setBusy(false);
    if (!res.ok) setError(ERROR_TEXT.failed);
    await reload();
  };

  return (
    <main className="ui-touch relative z-10 mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
          Zuordnungsregeln{loaded.companyLabel ? ` für ${loaded.companyLabel}` : ''}
        </h1>
        <div className="flex gap-2">
          <Link href="/app" className="ui-btn">Hochladen</Link>
          <Link href="/app/dashboard" className="ui-btn">Dashboard</Link>
        </div>
      </div>
      <p className="mb-6 text-sm" style={{ color: 'var(--muted)' }}>
        Eine Regel gilt für jeden Beleg, der ab jetzt in dieser Firma gelesen wird (Hochladen, Foto ersetzen, Seite neu lesen),
        und geht der Einschätzung des Modells vor. Bereits gespeicherte Belege ändert sie nicht. Wie ein Anbieter steuerlich
        behandelt wird, steht in den Anbieterregeln unter Finanzen.
      </p>

      <form onSubmit={add} className="glass-panel mb-6 grid gap-3 rounded-xl p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm" style={{ color: 'var(--muted)' }}>
          Art
          <select className="ui-input" value={type} onChange={(e) => setType(e.target.value as RuleType)}>
            {(Object.keys(TYPE_LABELS) as RuleType[]).map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm" style={{ color: 'var(--muted)' }}>
          {type === 'freetext' ? 'Hinweis' : 'Text'}
          <input className="ui-input" value={matchValue} onChange={(e) => setMatchValue(e.target.value)} maxLength={300} required />
        </label>
        <label className="flex flex-col gap-1 text-sm" style={{ color: 'var(--muted)' }}>
          Zuordnung
          <select className="ui-input" value={zuordnung} onChange={(e) => setZuordnung(e.target.value)}>
            {ZUORDNUNG_OPTIONS.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm" style={{ color: 'var(--muted)' }}>
          Kategorie (optional)
          <select className="ui-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">wie gelesen</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>Regel speichern</button>
          {error && <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      </form>

      {loaded.rules.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Noch keine Regeln für diese Firma.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {loaded.rules.map((rule) => (
            <li key={rule.id} className="glass-panel flex flex-wrap items-center justify-between gap-2 rounded-lg px-4 py-3 text-sm">
              <span style={{ color: 'var(--foreground)' }}>
                {TYPE_LABELS[rule.type]} „{rule.matchValue}“: {rule.zuordnung}
                {rule.categoryOverride ? `, ${rule.categoryOverride}` : ''}
              </span>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => void remove(rule)} aria-label={`Regel „${rule.matchValue}“ löschen`}>
                Löschen
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
