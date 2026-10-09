'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDay } from '@/lib/meals/messages';
import { CHECK_LABELS, ORIGIN_LABELS, PURPOSE_LABELS, financeActionMessage } from '@/lib/tax/messages';
import { formatCents } from '@/lib/tax/money';
import type { AssetView, StatementItem, StatementView } from '@/lib/tax/service';
import type { OpenCheckKind } from '@/lib/tax/types';
import { decideItem, disposeAsset, removeAsset, removeVendorRule, resetItem, saveAsset, type Result } from './actions';
import AssetsTab, { type AssetDraft, type DisposalDraft } from './AssetsTab';
import TreatmentForm, { type TreatmentSubmit } from './TreatmentForm';

type TabKey = 'open' | 'statement' | 'assets' | 'vendors';

/** Checks one setting answers for every item at once: shown as one notice, not once per receipt. */
const WORKSPACE_CHECKS: OpenCheckKind[] = ['small_business_unanswered', 'regular_taxation_not_computed'];
/** Checks that are resolved on the receipt itself or in the meal register, not with a decision here. */
const MEAL_CHECKS: OpenCheckKind[] = ['meal_incomplete', 'meal_without_register_facts'];
const RECEIPT_CHECKS: OpenCheckKind[] = ['no_date', 'no_amount', 'no_exchange_rate'];
/** Checks that are resolved by making the receipt part of an asset (or by adding its net amount). */
const ASSET_CHECKS: OpenCheckKind[] = ['needs_asset', 'net_amount_needed'];

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

function allocationText(item: StatementItem): string {
  if (!item.allocations) return 'nicht entschieden';
  return item.allocations.map((a) => `${a.shareBp / 100} % ${PURPOSE_LABELS[a.purpose]}`).join(' + ');
}

/** The items a person has to act on, oldest first; workspace-wide questions are left to the notice above. */
export function openQueue(view: StatementView): StatementItem[] {
  return view.items.filter((i) => i.checks.some((c) => c.blocking && !WORKSPACE_CHECKS.includes(c.kind)));
}

export default function FinanceClient({ initial }: { initial: StatementView }) {
  const tabsId = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState<TabKey>(() => (openQueue(initial).length > 0 ? 'open' : 'statement'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [assetFromRow, setAssetFromRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A different year arrives as new props after the navigation.
  const [seenYear, setSeenYear] = useState(initial.year);
  if (initial.year !== seenYear) {
    setSeenYear(initial.year);
    setView(initial);
    setSelectedId(null);
    setEditingId(null);
    setOpenLine(null);
    setAssetFromRow(null);
    setError(null);
    setNotice(null);
  }

  const queue = useMemo(() => openQueue(view), [view]);
  const selected = queue.find((i) => i.rowId === selectedId) ?? queue[0] ?? null;
  const itemsById = useMemo(() => new Map(view.items.map((i) => [i.rowId, i])), [view]);
  const assetsById = useMemo(() => new Map(view.assets.map((a) => [a.id, a])), [view]);
  const openAssets = view.assets.filter((a) => a.checks.length > 0).length;
  const estimated = view.items.filter((i) => i.checks.some((c) => c.kind === 'amount_estimated')).length;
  const blockedBySetting =
    view.items.filter((i) => i.checks.some((c) => WORKSPACE_CHECKS.includes(c.kind))).length;

  function run(action: () => Promise<Result<StatementView>>, done: string, after?: (next: StatementView) => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      let result: Result<StatementView>;
      try {
        result = await action();
      } catch {
        // The request itself failed (offline, server restart): say so instead of looking saved.
        setError(financeActionMessage('failed'));
        return;
      }
      if (!result.ok) {
        setError(financeActionMessage(result.error, result.detail));
        return;
      }
      setView(result.value);
      setNotice(done);
      after?.(result.value);
    });
  }

  function decide(item: StatementItem, submit: TreatmentSubmit) {
    const label = item.vendor || item.label;
    run(
      () =>
        decideItem(view.year, {
          rowId: item.rowId,
          treatment: submit.treatment,
          applyToVendor: submit.applyToVendor ?? undefined,
        }),
      submit.applyToVendor ? `${label}: Regel für den Lieferanten gespeichert.` : `${label}: gespeichert.`,
      (next) => {
        setEditingId(null);
        // Advance to the entry after this one, as the meal queue does.
        const before = queue.findIndex((i) => i.rowId === item.rowId);
        const nextQueue = openQueue(next);
        const following = queue.slice(before + 1).find((i) => nextQueue.some((n) => n.rowId === i.rowId));
        setSelectedId(following?.rowId ?? nextQueue[0]?.rowId ?? null);
      },
    );
  }

  const saveAssetDraft = (assetId: string | null, draft: AssetDraft, done: () => void) =>
    run(() => saveAsset(view.year, assetId, draft), `${draft.label}: Anlage gespeichert.`, done);
  const deleteAssetView = (asset: AssetView) => run(() => removeAsset(view.year, asset.id), `${asset.label}: Anlage gelöscht.`);
  const disposeAssetView = (asset: AssetView, disposal: DisposalDraft | null, done: () => void) =>
    run(
      () => disposeAsset(view.year, asset.id, disposal),
      disposal ? `${asset.label}: Abgang gespeichert.` : `${asset.label}: Abgang zurückgenommen.`,
      done,
    );

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'open', label: 'Offen', count: queue.length },
    { key: 'statement', label: 'EÜR' },
    { key: 'assets', label: 'Anlagen', count: view.assets.length },
    { key: 'vendors', label: 'Lieferanten', count: view.vendorRules.length },
  ];

  return (
    <main className="relative z-10 min-h-svh px-4 pb-16 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
              Finanzen
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Einnahmenüberschussrechnung aus den Belegen, Zeile für Zeile nachvollziehbar.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`${tabsId}-year`}>
              Jahr
            </label>
            <select
              id={`${tabsId}-year`}
              className="ui-input"
              style={{ width: 'auto' }}
              value={view.year}
              onChange={(e) => router.push(`/app/finance?jahr=${e.target.value}`)}
            >
              {view.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <Link href="/app/meals" className="ui-btn">
              Bewirtungen
            </Link>
            <Link href="/app/dashboard" className="ui-btn">
              Dashboard
            </Link>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {!view.initialized && (
            <p className="ui-note ui-note-warn">
              Für diesen Arbeitsbereich gibt es noch keine Belegtabelle. Sie wird beim ersten Öffnen des{' '}
              <Link href="/app/dashboard" className="underline">
                Dashboards
              </Link>{' '}
              angelegt.
            </p>
          )}
          {view.smallBusiness === null && view.items.length > 0 && (
            <p className="ui-note ui-note-warn">
              Die Frage zur Kleinunternehmerregelung (§ 19 Umsatzsteuergesetz) ist noch nicht beantwortet. Davon hängt
              ab, ob brutto oder netto abgezogen wird; bis dahin wird kein Beleg gerechnet ({blockedBySetting}{' '}
              betroffen). Die Frage wird im{' '}
              <Link href="/app/meals" className="underline">
                Bewirtungsverzeichnis
              </Link>{' '}
              unter „Verzeichnis“ gestellt.
            </p>
          )}
          {view.smallBusiness === false && (
            <p className="ui-note ui-note-warn">
              Für diesen Arbeitsbereich gilt die Regelbesteuerung. Nettobeträge und Vorsteuer werden hier noch nicht
              gerechnet, deshalb bleiben {blockedBySetting} Belege außerhalb der Summen. Es wird nichts auf falscher
              Grundlage geschätzt.
            </p>
          )}
          {!view.rulesExact && (
            <p className="ui-note ui-note-warn">
              Für {view.year} sind noch keine eigenen Regeln hinterlegt. Gerechnet wird mit den Regeln von{' '}
              {view.rulesYear}.
            </p>
          )}
          {view.rulesExact && view.lines.some((l) => l.numbering === 'unverified') && (
            <p className="ui-note">
              Für einige Zeilen der Anlage N {view.year} sind die Zeilennummern noch nicht mit dem amtlichen Vordruck
              abgeglichen. Dort wird nur die Bezeichnung angezeigt, keine Nummer eines anderen Jahres.
            </p>
          )}
          {view.lines.some((l) => l.numbering === 'structured') && (
            <p className="ui-note">
              Für Fahrten zur Tätigkeitsstätte und die Tagespauschale fragt das Formular Tage und Entfernungen ab,
              keinen Betrag. Die hier gezeigte Summe dient der Übersicht und wird nicht in eine Formularzeile
              eingetragen.
            </p>
          )}
          <p className="ui-note">
            Einnahmen aus Rechnungen werden noch nicht erfasst. Diese Ansicht zeigt die Ausgabenseite (und Erlöse aus
            dem Verkauf von Anlagen); ein Gewinn oder Verlust wird erst ausgewiesen, wenn Rechnungen und
            Zahlungseingänge vorliegen.
          </p>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { label: `Betriebsausgaben ${view.year}`, value: euro(view.businessExpenseCents), hint: `${view.countedItems} Belege gerechnet` },
            { label: 'Kosten für die Anlage N', value: euro(view.employmentCostCents), hint: 'Studium und Anstellung' },
            {
              label: 'Offene Prüfungen',
              value: String(queue.length),
              hint:
                [estimated > 0 ? `${estimated} mit geschätztem Betrag` : '', openAssets > 0 ? `${openAssets} Anlagen mit offener Prüfung` : '']
                  .filter(Boolean)
                  .join(', ') || 'Belege, die eine Entscheidung brauchen',
            },
          ].map((tile) => (
            <div key={tile.label} className="glass-panel rounded-xl p-4">
              <dt className="ui-label">{tile.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                {tile.value}
              </dd>
              <dd className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                {tile.hint}
              </dd>
            </div>
          ))}
        </dl>

        <div role="tablist" aria-label="Bereiche der Finanzübersicht" className="mt-6 flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--border)' }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`${tabsId}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${tabsId}-panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150"
              style={{
                borderColor: tab === t.key ? 'var(--accent)' : 'transparent',
                color: tab === t.key ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div role="status" aria-live="polite" className="mt-4 min-h-5 text-sm" style={{ color: 'var(--muted)' }}>
          {notice}
        </div>
        {error && tab !== 'open' && tab !== 'assets' && (
          <p className="ui-note ui-note-danger mt-2" role="alert">
            {error}
          </p>
        )}

        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="mt-4">
          {tab === 'open' &&
            (queue.length === 0 ? (
              <div className="glass-panel rounded-xl p-8 text-center">
                <p className="text-base font-medium" style={{ color: 'var(--foreground)' }}>
                  Keine offenen Prüfungen für {view.year}.
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
                  Jeder Beleg des Jahres ist zugeordnet. Neue Belege erscheinen hier, sobald eine Entscheidung fehlt.
                </p>
                <button type="button" className="ui-btn ui-btn-primary mt-4" onClick={() => setTab('statement')}>
                  Zur EÜR
                </button>
              </div>
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <nav aria-label="Offene Belege">
                  <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {queue.length === 1 ? 'Noch 1 Beleg offen.' : `Noch ${queue.length} Belege offen.`}
                  </p>
                  <ul className="max-h-[40svh] space-y-1.5 overflow-y-auto pr-1 lg:max-h-[75svh]">
                    {queue.map((item) => {
                      const isSelected = selected?.rowId === item.rowId;
                      return (
                        <li key={item.rowId}>
                          <button
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => {
                              setSelectedId(item.rowId);
                              setError(null);
                            }}
                            className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150"
                            style={{
                              borderColor: isSelected ? 'rgba(226, 163, 72, 0.55)' : 'var(--border)',
                              background: isSelected ? 'var(--accent-muted)' : 'var(--surface)',
                            }}
                          >
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                                {item.vendor || item.label}
                              </span>
                              <span className="shrink-0 text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                                {item.amountCents !== null ? euro(item.amountCents) : ''}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-xs" style={{ color: 'var(--muted)' }}>
                              {formatDay(item.date)} ·{' '}
                              {item.checks
                                .filter((c) => c.blocking && !WORKSPACE_CHECKS.includes(c.kind))
                                .map((c) => CHECK_LABELS[c.kind])
                                .join(', ')}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
                {selected && (
                  <section aria-label="Beleg entscheiden" className="glass-panel rounded-xl p-4 sm:p-5">
                    <ItemHeader item={selected} />
                    <OpenItemBody
                      // A fresh form per receipt: nothing typed for one leaks into the next.
                      key={selected.rowId}
                      item={selected}
                      view={view}
                      busy={pending}
                      error={error}
                      onSubmit={(submit) => decide(selected, submit)}
                      onMakeAsset={() => {
                        setAssetFromRow(selected.rowId);
                        setError(null);
                        setTab('assets');
                      }}
                    />
                  </section>
                )}
              </div>
            ))}

          {tab === 'statement' && (
            <div className="space-y-6">
              {view.lines.length === 0 ? (
                <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
                  Für {view.year} ist noch kein Beleg gerechnet.
                  {queue.length > 0 ? ' Offene Belege stehen unter „Offen“.' : ''}
                </div>
              ) : (
                (
                  [
                    { id: 'revenue', form: 'euer', kind: 'revenue', title: 'Anlage EÜR: Betriebseinnahmen (bisher nur aus Anlagen)', total: view.businessRevenueCents },
                    { id: 'expense', form: 'euer', kind: 'expense', title: 'Anlage EÜR: Betriebsausgaben', total: view.businessExpenseCents },
                    { id: 'employment', form: 'employment', kind: 'expense', title: 'Anlage N: Kosten aus Studium und Anstellung', total: view.employmentCostCents },
                  ] as const
                ).map((group) => {
                  const lines = view.lines.filter((l) => l.form === group.form && l.kind === group.kind);
                  if (lines.length === 0) return null;
                  return (
                    <section key={group.id} className="glass-panel overflow-hidden rounded-xl">
                      <h2 className="px-4 pt-4 text-base font-semibold" style={{ color: 'var(--foreground)' }}>
                        {group.title}
                      </h2>
                      <ul className="mt-2">
                        {lines.map((line) => {
                          const open = openLine === line.key;
                          return (
                            <li key={line.key} className="border-t" style={{ borderColor: 'var(--border)' }}>
                              <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => setOpenLine(open ? null : line.key)}
                                className="flex w-full items-baseline justify-between gap-4 px-4 py-3 text-left"
                              >
                                <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                  {line.line !== null && (
                                    <span className="mr-2 tabular-nums" style={{ color: 'var(--muted)' }}>
                                      Zeile {line.line}
                                    </span>
                                  )}
                                  {line.label}
                                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                    {[
                                      line.itemIds.length === 1 ? '1 Beleg' : line.itemIds.length > 1 ? `${line.itemIds.length} Belege` : '',
                                      line.assetIds.length === 1 ? '1 Anlage' : line.assetIds.length > 1 ? `${line.assetIds.length} Anlagen` : '',
                                    ]
                                      .filter(Boolean)
                                      .join(', ')}
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm font-medium tabular-nums" style={{ color: 'var(--foreground)' }}>
                                  {euro(line.cents)}
                                  {line.nonDeductibleCents > 0 && (
                                    <span className="block text-xs font-normal" style={{ color: 'var(--muted)' }}>
                                      nicht abziehbar {euro(line.nonDeductibleCents)}
                                    </span>
                                  )}
                                </span>
                              </button>
                              {open && (
                                <ul className="pb-2">
                                  {line.assetIds.map((id) => {
                                    const asset = assetsById.get(id);
                                    if (!asset) return null;
                                    const part = asset.parts.filter((p) => p.lineKey === line.key).reduce((s, p) => s + p.cents, 0);
                                    return (
                                      <li key={id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
                                        <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                          {asset.label}
                                          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                            Anlage{asset.acquisitionDate ? `, angeschafft ${formatDay(asset.acquisitionDate)}` : ''}
                                            {asset.businessShareBp < 10000 ? ` · ${asset.businessShareBp / 100} % betrieblich` : ''}
                                          </span>
                                        </span>
                                        <span className="flex items-baseline gap-3">
                                          <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(part)}</span>
                                          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setTab('assets')}>
                                            Anlagen
                                          </button>
                                        </span>
                                      </li>
                                    );
                                  })}
                                  {line.itemIds.map((id) => {
                                    const item = itemsById.get(id);
                                    if (!item) return null;
                                    const part = item.parts.filter((p) => p.lineKey === line.key).reduce((s, p) => s + p.cents, 0);
                                    const editing = editingId === `${line.key}:${id}`;
                                    return (
                                      <li key={id} className="border-t px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
                                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                          <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                            {item.vendor || item.label}
                                            <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                              {formatDay(item.date)} · {allocationText(item)}
                                              {item.allocationOrigin ? ` (${ORIGIN_LABELS[item.allocationOrigin]})` : ''}
                                              {item.checks.some((c) => c.kind === 'amount_estimated') ? ' · Betrag geschätzt' : ''}
                                            </span>
                                          </span>
                                          <span className="flex items-baseline gap-3">
                                            <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                                              {euro(part)}
                                              {item.amountCents !== null && part !== item.amountCents && (
                                                <span className="ml-1 text-xs" style={{ color: 'var(--muted)' }}>
                                                  von {euro(item.amountCents)}
                                                </span>
                                              )}
                                            </span>
                                            {item.isMeal ? (
                                              <Link href="/app/meals" className="ui-btn ui-btn-sm">
                                                Verzeichnis
                                              </Link>
                                            ) : (
                                              <button
                                                type="button"
                                                className="ui-btn ui-btn-sm"
                                                aria-expanded={editing}
                                                onClick={() => {
                                                  setEditingId(editing ? null : `${line.key}:${id}`);
                                                  setError(null);
                                                }}
                                              >
                                                {editing ? 'Schließen' : 'Ändern'}
                                              </button>
                                            )}
                                          </span>
                                        </div>
                                        {editing && (
                                          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                                            <TreatmentForm
                                              item={item}
                                              formLines={view.formLines}
                                              busy={pending}
                                              error={error}
                                              submitLabel="Speichern"
                                              onSubmit={(submit) => decide(item, submit)}
                                            />
                                            {item.hasDecision && (
                                              <button
                                                type="button"
                                                className="ui-btn ui-btn-sm mt-3"
                                                disabled={pending}
                                                onClick={() =>
                                                  run(
                                                    () => resetItem(view.year, item.rowId),
                                                    `${item.vendor || item.label}: Einzelentscheidung entfernt.`,
                                                    () => setEditingId(null),
                                                  )
                                                }
                                              >
                                                Einzelentscheidung entfernen (Regel oder Vorgabe gilt wieder)
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                        <li className="flex items-baseline justify-between gap-4 border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                            Summe
                          </span>
                          <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                            {euro(group.total)}
                          </span>
                        </li>
                      </ul>
                    </section>
                  );
                })
              )}
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {(['euer', 'employment'] as const)
                  .map((form) => {
                    const source = view.formSources[form];
                    const name = form === 'euer' ? 'Anlage EÜR' : 'Anlage N';
                    return source
                      ? `${name} nach: ${source.citation}, abgeglichen am ${formatDay(source.checkedOn)}.`
                      : `${name} ${view.year}: noch nicht mit einer amtlichen Quelle abgeglichen.`;
                  })
                  .join(' ')}{' '}
                Regeln zuletzt durchgesehen am {formatDay(view.rulesReviewedOn)}. Beträge sind Berechnungen aus den
                eigenen Belegen und ersetzen keine steuerliche Beratung.
              </p>
            </div>
          )}

          {tab === 'assets' && (
            <AssetsTab
              // Coming from the queue with a receipt opens a fresh form for it.
              key={assetFromRow ?? 'assets'}
              view={view}
              busy={pending}
              error={error}
              startFromRowId={assetFromRow}
              onStartHandled={() => setAssetFromRow(null)}
              onSave={saveAssetDraft}
              onDelete={deleteAssetView}
              onDispose={disposeAssetView}
            />
          )}

          {tab === 'vendors' &&
            (view.vendorRules.length === 0 ? (
              <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
                Noch keine Regel für einen Lieferanten. Eine Regel entsteht, wenn bei einem Beleg „Für alle Belege von …
                so behandeln“ angehakt wird.
              </div>
            ) : (
              <ul className="glass-panel divide-y rounded-xl" style={{ borderColor: 'var(--border)' }}>
                {view.vendorRules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                      {rule.vendorLabel}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {rule.effectiveFrom ? `ab ${formatDay(rule.effectiveFrom)}` : 'von Anfang an'} ·{' '}
                        {rule.allocations.map((a) => `${a.shareBp / 100} % ${PURPOSE_LABELS[a.purpose]}`).join(' + ')}
                        {rule.formLineKey ? ` · ${view.formLines.find((l) => l.key === rule.formLineKey)?.label ?? rule.formLineKey}` : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-danger"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`Regel für ${rule.vendorLabel} löschen? Belege ohne Einzelentscheidung fallen auf die Vorgaben zurück.`)) return;
                        run(() => removeVendorRule(view.year, rule.id), `Regel für ${rule.vendorLabel} gelöscht.`);
                      }}
                    >
                      Löschen
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </main>
  );
}

function ItemHeader({ item }: { item: StatementItem }) {
  return (
    <>
      <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
        {item.label}
      </h2>
      <p className="mb-4 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {item.vendor ? `${item.vendor} · ` : ''}
        {formatDay(item.date)}
        {item.amountCents !== null ? ` · ${euro(item.amountCents)}` : ''}
        {item.currency !== 'EUR' && item.gross !== null ? ` (${item.gross.toFixed(2).replace('.', ',')} ${item.currency})` : ''}
        {item.category ? ` · ${item.category}` : ''}
      </p>
    </>
  );
}

function OpenItemBody({
  item,
  view,
  busy,
  error,
  onSubmit,
  onMakeAsset,
}: {
  item: StatementItem;
  view: StatementView;
  busy: boolean;
  error: string | null;
  onSubmit: (submit: TreatmentSubmit) => void;
  onMakeAsset: () => void;
}) {
  const blocking = item.checks.filter((c) => c.blocking).map((c) => c.kind);
  if (blocking.some((k) => MEAL_CHECKS.includes(k))) {
    return (
      <div className="space-y-3">
        <p className="ui-note ui-note-warn">
          Diese Bewirtung zählt erst, wenn Teilnehmer, Anlass und Ort erfasst sind. Das geschieht im
          Bewirtungsverzeichnis; der abziehbare Betrag (70 %) kommt dann von dort.
        </p>
        <Link href="/app/meals" className="ui-btn ui-btn-primary">
          Im Bewirtungsverzeichnis ergänzen
        </Link>
      </div>
    );
  }
  const onReceipt = blocking.filter((k) => RECEIPT_CHECKS.includes(k));
  const assetCheck = blocking.find((k) => ASSET_CHECKS.includes(k));
  const limit = `${formatCents(view.assetLimits.lowValueNetLimitCents)} €`;
  return (
    <div className="space-y-4">
      {assetCheck && (
        <div className="ui-note ui-note-warn">
          <p>
            {assetCheck === 'needs_asset'
              ? `Dieser Beleg steht auf der Zeile für geringwertige Wirtschaftsgüter, kostet aber mehr als ${limit} netto. Er kann nicht sofort abgezogen werden, sondern wird als Anlage über die Nutzungsdauer abgeschrieben (Computerhardware: im Jahr der Anschaffung).`
              : `Dieser Beleg liegt nahe an der Grenze von ${limit} netto, und der Nettobetrag fehlt. Entweder den Nettobetrag im Dashboard am Beleg ergänzen oder den Beleg als Anlage führen.`}
          </p>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm mt-2" onClick={onMakeAsset}>
            Als Anlage führen
          </button>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Ist es kein Wirtschaftsgut (zum Beispiel eine Sammelrechnung über mehrere kleine Teile), unten eine andere
            Zeile wählen.
          </p>
        </div>
      )}
      {onReceipt.length > 0 && (
        <div className="ui-note ui-note-warn">
          <p>
            Am Beleg selbst fehlt etwas: {onReceipt.map((k) => CHECK_LABELS[k]).join(', ')}. Das wird im Dashboard am
            Beleg ergänzt; ohne diese Angabe kann er keinem Jahr und keiner Zeile zugerechnet werden.
          </p>
          <Link href="/app/dashboard" className="ui-btn ui-btn-sm mt-2">
            Zum Dashboard
          </Link>
        </div>
      )}
      <TreatmentForm item={item} formLines={view.formLines} busy={busy} error={error} submitLabel="Speichern und weiter" onSubmit={onSubmit} />
    </div>
  );
}
