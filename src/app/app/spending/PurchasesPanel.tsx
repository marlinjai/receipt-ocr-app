import Link from 'next/link';
import { formatCents } from '@/lib/tax/money';
import { PURCHASE_KIND_LABELS } from '@/lib/line-items/kinds';
import type { PurchasesOverview } from '@/lib/line-items/overview';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const euro = (cents: number) => `${formatCents(cents)} €`;

function Bar({ cents, max }: { cents: number; max: number }) {
  const width = max > 0 ? Math.max(2, Math.round((Math.abs(cents) / max) * 100)) : 0;
  return (
    <span aria-hidden="true" className="block h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <span className="block h-1.5 rounded-full" style={{ width: `${width}%`, background: cents < 0 ? 'var(--muted)' : 'var(--accent)' }} />
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass-panel mt-4 rounded-xl p-4" aria-label={title}>
      <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * "Was gekauft": what the receipts' lines say the money bought, per kind, per
 * item and per shop. The total is the receipts' totals; what their lines do
 * not explain is shown as its own amount, never hidden (plan decision 4).
 */
export default function PurchasesPanel({ overview }: { overview: PurchasesOverview }) {
  const period = overview.month === null ? `${overview.year}` : `${MONTHS[overview.month - 1]} ${overview.year}`;
  const withoutLines = overview.receipts - overview.receiptsWithLines;
  const maxKind = Math.max(0, ...overview.kinds.map((k) => Math.abs(k.cents)), Math.abs(overview.unexplainedCents));
  const maxCategory = Math.max(0, ...overview.categories.map((c) => Math.abs(c.cents)));

  if (overview.receipts === 0) {
    return (
      <p className="ui-note mt-4">
        In {period} gibt es in diesem Arbeitsbereich keine Belege{overview.unconverted > 0 ? ' mit einem Betrag in Euro oder einem Wechselkurs' : ''}.
      </p>
    );
  }

  return (
    <div>
      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={`Summen ${period}`}>
        {[
          { label: `Belege ${period}`, value: euro(overview.totalCents) },
          { label: 'Aufgeschlüsselt', value: euro(overview.linesCents) },
          { label: 'Nicht aufgeschlüsselt', value: euro(overview.unexplainedCents) },
          { label: 'Belege mit Positionen', value: `${overview.receiptsWithLines} von ${overview.receipts}` },
        ].map((card) => (
          <div key={card.label} className="glass-panel rounded-xl p-4">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              {card.label}
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
              {card.value}
            </p>
          </div>
        ))}
      </section>

      <div className="mt-3 space-y-2">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Geschäftliche und private Belege dieses Arbeitsbereichs. Gezählt wird der Gesamtbetrag jedes Belegs; was seine Positionen nicht erklären (ein Beleg ohne Positionen, eine Differenz), steht unter „nicht aufgeschlüsselt“.
        </p>
        {withoutLines > 0 && (
          <p className="ui-note">
            {withoutLines === 1 ? 'Ein Beleg hat' : `${withoutLines} Belege haben`} noch keine Positionen. Sie werden auf der{' '}
            <Link href="/app/dashboard" className="underline">
              Belegseite
            </Link>{' '}
            mit „Positionen lesen“ gelesen, und jeden Tag ein Teil von selbst.
          </p>
        )}
        {overview.unconverted > 0 && (
          <p className="ui-note ui-note-warn">
            {overview.unconverted === 1 ? 'Ein Beleg in einer anderen Währung hat' : `${overview.unconverted} Belege in einer anderen Währung haben`} keinen Wechselkurs und {overview.unconverted === 1 ? 'zählt' : 'zählen'} hier nicht mit.
          </p>
        )}
      </div>

      <Section title="Nach Art">
        <ul className="space-y-2.5">
          {overview.kinds.map((k) => (
            <li key={k.kind}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span style={{ color: 'var(--foreground)' }}>{k.label}</span>
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {euro(k.cents)}
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {k.lines} {k.lines === 1 ? 'Position' : 'Positionen'}
                  </span>
                </span>
              </div>
              <Bar cents={k.cents} max={maxKind} />
            </li>
          ))}
          {overview.unexplainedCents !== 0 && (
            <li>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span style={{ color: 'var(--muted)' }}>Nicht aufgeschlüsselt</span>
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--muted)' }}>
                  {euro(overview.unexplainedCents)}
                </span>
              </div>
              <Bar cents={overview.unexplainedCents} max={maxKind} />
            </li>
          )}
        </ul>
      </Section>

      {overview.categories.length > 0 && (
        <Section title="Nach Kategorie">
          <ul className="space-y-2.5">
            {overview.categories.map((c) => (
              <li key={c.category}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span style={{ color: 'var(--foreground)' }}>{c.label}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {euro(c.cents)}
                  </span>
                </div>
                <Bar cents={c.cents} max={maxCategory} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
            Pfand und Rabatte zählen zur Kategorie des Belegs, auf dem sie stehen.
          </p>
        </Section>
      )}

      {overview.topItems.length > 0 && (
        <Section title="Am häufigsten gekauft">
          <ol className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {overview.topItems.map((item) => (
              <li key={`${item.text}-${item.kind}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
                <span className="min-w-0 break-words" style={{ color: 'var(--foreground)' }}>
                  {item.text}
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {PURCHASE_KIND_LABELS[item.kind]}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {item.count} mal, {euro(item.cents)}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {overview.shops.length > 0 && (
        <Section title="Nach Händler">
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {overview.shops.map((shop) => (
              <li key={shop.vendor} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 break-words font-medium" style={{ color: 'var(--foreground)' }}>
                    {shop.vendor}
                  </span>
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {euro(shop.cents)}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {shop.receipts} {shop.receipts === 1 ? 'Beleg' : 'Belege'}
                    </span>
                  </span>
                </div>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {shop.kinds.map((k) => `${k.label} ${euro(k.cents)}`).join(', ')}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {overview.months.length > 0 && (
        <Section title="Nach Monat">
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {overview.months.map((m) => (
              <li key={m.month} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span style={{ color: 'var(--foreground)' }}>{MONTHS[m.month - 1]}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {euro(m.totalCents)}
                    {m.totalCents !== m.linesCents && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        davon aufgeschlüsselt {euro(m.linesCents)}
                      </span>
                    )}
                  </span>
                </div>
                {m.kinds.length > 0 && (
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {m.kinds.map((k) => `${k.label} ${euro(k.cents)}`).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
