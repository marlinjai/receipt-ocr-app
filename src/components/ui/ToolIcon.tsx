/**
 * The line icons of the receipt tools (viewer toolbar, file list, preview).
 *
 * Drawn on a 24 unit grid, every glyph spanning about 14 to 18 of its units,
 * so at the default 20 pixels each one is 12 to 15 pixels across plus its
 * stroke: big enough to tell rotate left from rotate right at a glance.
 * Always decorative: the button around it carries the accessible name.
 */

const PATHS = {
  rotateRight: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  minus: 'M4 12h16',
  plus: 'M4 12h16M12 4v16',
  chevronLeft: 'm16 20-8-8 8-8',
  chevronRight: 'm8 20 8-8-8-8',
  external: 'M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  close: 'M19 5 5 19M5 5l14 14',
} as const;

export type ToolIconName = keyof typeof PATHS | 'rotateLeft';

export default function ToolIcon({ name, size = 20 }: { name: ToolIconName; size?: number }) {
  // Rotate left is rotate right mirrored, so both arrows are the same shape.
  const mirrored = name === 'rotateLeft';
  const d = PATHS[mirrored ? 'rotateRight' : name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
