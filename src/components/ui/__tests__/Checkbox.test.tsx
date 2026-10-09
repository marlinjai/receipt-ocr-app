// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Checkbox from '../Checkbox';

afterEach(cleanup);

function Controlled({ indeterminate = false, disabled = false, onSeen = vi.fn() }: { indeterminate?: boolean; disabled?: boolean; onSeen?: (v: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      label="Alle auswählen"
      onChange={(v) => {
        onSeen(v);
        setChecked(v);
      }}
    />
  );
}

describe('Checkbox', () => {
  it('is a real checkbox named by its label, and a click on the label toggles it', async () => {
    const user = userEvent.setup();
    const onSeen = vi.fn();
    render(<Controlled onSeen={onSeen} />);
    const box = screen.getByRole('checkbox', { name: 'Alle auswählen' }) as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    await user.click(screen.getByText('Alle auswählen'));
    expect(box.checked).toBe(true);
    expect(onSeen).toHaveBeenLastCalledWith(true);
    await user.click(box);
    expect(box.checked).toBe(false);
    expect(onSeen).toHaveBeenLastCalledWith(false);
  });

  it('works from the keyboard: Tab reaches it, Space toggles it', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    await user.tab();
    expect(document.activeElement).toBe(box);
    await user.keyboard(' ');
    expect(box.checked).toBe(true);
  });

  it('shows the mixed state through the native property, and never while fully checked', () => {
    const { rerender } = render(<Checkbox checked={false} indeterminate label="Alle" onChange={vi.fn()} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
    rerender(<Checkbox checked indeterminate label="Alle" onChange={vi.fn()} />);
    expect(box.indeterminate).toBe(false);
    rerender(<Checkbox checked={false} label="Alle" onChange={vi.fn()} />);
    expect(box.indeterminate).toBe(false);
  });

  it('a hidden label still names the box for screen readers', () => {
    render(<Checkbox checked={false} label="Lokal A auswählen" hideLabel onChange={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Lokal A auswählen' })).toBeTruthy();
    expect(screen.getByText('Lokal A auswählen').className).toBe('sr-only');
  });

  it('disabled: cannot be toggled', async () => {
    const user = userEvent.setup();
    const onSeen = vi.fn();
    render(<Controlled disabled onSeen={onSeen} />);
    await user.click(screen.getByText('Alle auswählen'));
    expect(onSeen).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('the drawn box is decoration: hidden from assistive technology, both marks present for the styles to pick from', () => {
    const { container } = render(<Checkbox checked={false} label="Alle" onChange={vi.fn()} />);
    const drawn = container.querySelector('.ui-checkbox-box')!;
    expect(drawn.getAttribute('aria-hidden')).toBe('true');
    expect(drawn.querySelector('.ui-checkbox-tick')).toBeTruthy();
    expect(drawn.querySelector('.ui-checkbox-dash')).toBeTruthy();
    // The box follows the input directly: the state styles hang on that order.
    expect(container.querySelector('input + .ui-checkbox-box')).toBe(drawn);
  });
});
