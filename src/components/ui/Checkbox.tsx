'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface CheckboxProps {
  checked: boolean;
  /** Mixed state, for a "select all" box when only some entries are checked. Shown instead of the tick. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The accessible name. Rendered next to the box unless `hideLabel` is set. */
  label: ReactNode;
  /** Keep the label for screen readers only (a box inside a list row that already shows the text). */
  hideLabel?: boolean;
  className?: string;
}

/**
 * The app's checkbox: the brand's brushed gold when checked, with the mark
 * drawn in. It is a real `<input type="checkbox">` (keyboard, forms and
 * screen readers get the native behaviour, including the mixed state); only
 * its looks are replaced. The hit area is 40 pixels whatever the box size,
 * and nothing about it changes size between states.
 */
export default function Checkbox({ checked, indeterminate = false, onChange, disabled, label, hideLabel, className }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  // `indeterminate` exists only as a DOM property, there is no attribute for it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label className={`ui-checkbox ${className ?? ''}`.trim()}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 12 12" focusable="false">
          <path className="ui-checkbox-tick" d="M2.25 6.4 4.9 9 9.75 3.4" />
          <path className="ui-checkbox-dash" d="M2.75 6h6.5" />
        </svg>
      </span>
      <span className={hideLabel ? 'sr-only' : 'ui-checkbox-label'}>{label}</span>
    </label>
  );
}
