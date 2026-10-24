/**
 * The icons of the dashboard's actions, shared by the wide action row and the
 * phone menu so both draw the same marks. Decorative: every action names itself.
 */

const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function OverviewIcon() {
  return (
    <svg {...base}>
      <path d="M3 3v18h18" />
      <rect x="7" y="10" width="3" height="8" />
      <rect x="12" y="6" width="3" height="12" />
      <rect x="17" y="13" width="3" height="5" />
    </svg>
  );
}

export function FinanceIcon() {
  return (
    <svg {...base}>
      <path d="M4 4h16v16H4z" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}

export function MealsIcon() {
  return (
    <svg {...base}>
      <path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5" />
      <path d="M17 3c-1.7 1.5-2.5 3.5-2.5 6s.8 4 2.5 4v8" />
    </svg>
  );
}

export function ContactsIcon() {
  return (
    <svg {...base}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.9c1.6.9 2.7 2.6 3 5.1" />
    </svg>
  );
}

export function ExportIcon() {
  return (
    <svg {...base}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg {...base}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

export function AiIcon() {
  return (
    <svg {...base}>
      <path d="M12 3l1.5 3.7 3.8.5-2.8 2.6.7 3.9L12 12l-3.2 1.7.7-3.9-2.8-2.6 3.8-.5z" />
      <path d="M12 3v0M18.4 5.6v0M21 12v0M18.4 18.4v0M12 21v0M5.6 18.4v0M3 12v0M5.6 5.6v0" />
    </svg>
  );
}
