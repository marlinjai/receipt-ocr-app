'use client';

import { useId, useState } from 'react';
import { formatCents } from '@/lib/tax/money';
import { SPENDING_CATEGORY_LABELS } from '@/lib/spending/categories';
import { CATEGORY_GROUP, CHART_GROUPS, axisStep, groupLabel, type ChartGroup, type MonthStack, type TopCounterparty } from '@/lib/spending/charts';

/**
 * Two of the three charts of the spending overview, in plain HTML and CSS (no
 * chart library): the months by category and the biggest counterparties; the
 * third, budget against spent, is the budget block (`BudgetsPanel.tsx`). Each
 * has its numbers in words as well (a table or a labelled list), scrolls
 * sideways inside its panel on a phone, and colours a category the same
 * everywhere (`CATEGORY_GROUP`).
 */

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

/** Whole euros for an axis: "1.200 €". */
function euroShort(cents: number): string {
  return `${Math.round(cents / 100).toLocaleString('de-DE')} €`;
}

export const groupColor = (group: ChartGroup) => `var(--chart-${group})`;

export function Swatch({ group }: { group: ChartGroup }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${group === 'unclear' ? 'ui-chart-hatch' : ''}`} style={{ backgroundColor: groupColor(group) }} />;
}

const label = (group: ChartGroup) => groupLabel(group, SPENDING_CATEGORY_LABELS);

/** Height of the plot area of the months chart, in pixels. */
const PLOT_HEIGHT = 160;

export function MonthsChart({
  year,
  stacks,
  budgetSum,
  selectedMonth,
  onSelect,
}: {
  year: number;
  stacks: readonly MonthStack[];
  /** The sum of the monthly category budgets, or null. */
  budgetSum: number | null;
  selectedMonth: number | null;
  onSelect: (month: number | null) => void;
}) {
  const id = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const top = Math.max(1, budgetSum ?? 0, ...stacks.map((s) => CHART_GROUPS.reduce((sum, g) => sum + Math.max(0, s.groups[g]), 0)));
  const step = axisStep(top);
  const ceiling = Math.ceil(top / step) * step;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step);
  const px = (cents: number) => (Math.max(0, cents) / ceiling) * PLOT_HEIGHT;
  const present = CHART_GROUPS.filter((g) => stacks.some((s) => s.groups[g] > 0));
  const shown = hovered ?? selectedMonth;
  const readout = shown === null ? null : stacks[shown - 1];

  return (
    <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Monate {year} nach Kategorie
      </h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Ein Monat antippen zeigt darunter nur diesen Monat; noch einmal tippen zeigt wieder das ganze Jahr.
      </p>
      {/* The month under the pointer or the focus, in words: the chart's tooltip. Not announced: each month's button says its total. */}
      <p className="mt-2 min-h-[2.5rem] text-xs" style={{ color: 'var(--foreground)' }} aria-hidden="true">
        {readout ? (
          <>
            <span className="font-semibold">
              {MONTHS[readout.month - 1]} {year}: {euro(readout.cents)}
            </span>
            {present
              .filter((g) => readout.groups[g] > 0)
              .sort((a, b) => readout.groups[b] - readout.groups[a])
              .slice(0, 4)
              .map((g) => (
                <span key={g} className="ml-3 inline-flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                  <Swatch group={g} />
                  {label(g)} {euro(readout.groups[g])}
                </span>
              ))}
          </>
        ) : (
          <span style={{ color: 'var(--muted)' }}>Zeiger oder Fokus auf einen Monat zeigt seine Zahlen.</span>
        )}
      </p>
      {/* Room above the plot, so the top value of the axis is not cut off by the scrolling box. */}
      <div className="ui-chart-scroll ui-scroll mt-1 pt-2">
        <div className="relative" style={{ minWidth: 480, height: PLOT_HEIGHT + 24, paddingLeft: 56 }}>
          {/* Grid and axis: recessive hairlines, the value at their left. */}
          {ticks.map((t) => (
            <div key={t} aria-hidden="true" className="absolute right-0" style={{ left: 56, bottom: 24 + px(t), borderTop: `1px solid ${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}` }}>
              <span className="absolute -translate-y-1/2 text-[10px] tabular-nums" style={{ right: 'calc(100% + 6px)', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                {euroShort(t)}
              </span>
            </div>
          ))}
          {budgetSum !== null && (
            <div aria-hidden="true" className="pointer-events-none absolute right-0 z-10" style={{ left: 56, bottom: 24 + px(budgetSum), borderTop: '2px dashed var(--foreground)' }}>
              <span className="absolute right-0 -translate-y-full pb-0.5 text-[10px]" style={{ color: 'var(--foreground)' }}>
                Budgets {euroShort(budgetSum)} im Monat
              </span>
            </div>
          )}
          <ol className="absolute right-0 grid grid-cols-12 gap-1" style={{ left: 56, bottom: 0, height: PLOT_HEIGHT + 24 }}>
            {stacks.map((s) => {
              const selected = selectedMonth === s.month;
              const dimmed = selectedMonth !== null && !selected;
              return (
                <li key={s.month} className="h-full">
                  <button
                    type="button"
                    className="flex h-full w-full flex-col items-stretch justify-end rounded"
                    aria-pressed={selected}
                    aria-label={`${MONTHS[s.month - 1]}: ${euro(s.cents)}${selected ? ', gewählt' : ''}`}
                    onClick={() => onSelect(selected ? null : s.month)}
                    onMouseEnter={() => setHovered(s.month)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(s.month)}
                    onBlur={() => setHovered(null)}
                  >
                    <span className="flex flex-col-reverse items-stretch" style={{ height: PLOT_HEIGHT, justifyContent: 'flex-start', opacity: dimmed ? 0.35 : 1 }}>
                      {CHART_GROUPS.map((g) => {
                        const h = px(s.groups[g]);
                        if (h < 0.5) return null;
                        return (
                          <span
                            key={g}
                            className={`block w-full first:rounded-b-sm last:rounded-t ${g === 'unclear' ? 'ui-chart-hatch' : ''}`}
                            style={{ height: h, backgroundColor: groupColor(g), borderTop: '2px solid var(--background)' }}
                          />
                        );
                      })}
                    </span>
                    <span className="mt-1 h-5 text-center text-[10px]" style={{ color: selected ? 'var(--accent)' : 'var(--muted)', fontWeight: selected ? 600 : 400 }}>
                      {MONTHS_SHORT[s.month - 1]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {present.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legende" style={{ color: 'var(--muted)' }}>
          {present.map((g) => (
            <li key={g} className="inline-flex items-center gap-1.5">
              <Swatch group={g} />
              {label(g)}
            </li>
          ))}
          {budgetSum !== null && (
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block w-4" style={{ borderTop: '2px dashed var(--foreground)' }} />
              Summe der Monatsbudgets (sie zählen nur den privaten Teil)
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
          In diesem Jahr gibt es noch keine Ausgaben.
        </p>
      )}
      <details className="ui-disclosure mt-3">
        <summary className="cursor-pointer text-xs font-semibold">Als Tabelle</summary>
        <div className="ui-scroll mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Ausgaben {year} nach Monat und Kategorie</caption>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th scope="col" className="py-1 pr-3 font-normal">Monat</th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">Summe</th>
                {present.map((g) => (
                  <th key={g} scope="col" className="py-1 pr-3 text-right font-normal">
                    {label(g)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stacks.map((s) => (
                <tr key={s.month}>
                  <th scope="row" className="py-1 pr-3 font-normal">
                    {MONTHS[s.month - 1]}
                  </th>
                  <td className="py-1 pr-3 text-right tabular-nums">{euro(s.cents)}</td>
                  {present.map((g) => (
                    <td key={g} className="py-1 pr-3 text-right tabular-nums">
                      {euro(s.groups[g])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function TopCounterpartiesChart({ items, period }: { items: readonly TopCounterparty[]; period: string }) {
  const id = useId();
  const largest = Math.max(1, ...items.map((i) => i.cents));
  return (
    <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Größte Gegenseiten {period}
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          In diesem Zeitraum gibt es keine Ausgaben.
        </p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {items.map((item, i) => (
            <li key={item.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate" style={{ color: 'var(--foreground)' }} title={item.name}>
                  <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
                    {i + 1}.{' '}
                  </span>
                  {item.name}
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {euro(item.cents)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Swatch group={CATEGORY_GROUP[item.category]} />
                  <span className="truncate">
                    {SPENDING_CATEGORY_LABELS[item.category]}, {item.count} {item.count === 1 ? 'Zahlung' : 'Zahlungen'}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{item.share.toLocaleString('de-DE')} %</span>
              </div>
              <div aria-hidden="true" className="mt-1 h-1.5 w-full rounded-full" style={{ background: 'var(--chart-grid)' }}>
                <div className={`h-1.5 rounded-full ${CATEGORY_GROUP[item.category] === 'unclear' ? 'ui-chart-hatch' : ''}`} style={{ width: `${(item.cents / largest) * 100}%`, backgroundColor: groupColor(CATEGORY_GROUP[item.category]) }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
