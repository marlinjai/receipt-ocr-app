'use client';

import { useState, type ReactNode } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

/**
 * The one question the meals page asks before it throws away what was typed
 * into a meal form and not saved: on opening another entry, on leaving the
 * tab, on anything else that takes the form away.
 *
 * `subject` names the entry the unsaved changes belong to, as it reads in a
 * sentence; null while nothing is unsaved. `afterDiscard(run)` runs at once
 * when nothing is unsaved, and otherwise only once the user chose to discard.
 */
export function useDiscardGuard(subject: string | null) {
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  const afterDiscard = (run: () => void) => {
    if (subject !== null) setPending({ run });
    else run();
  };

  const dialog: ReactNode = (
    <ConfirmDialog
      open={pending !== null}
      title="Ungespeicherte Änderungen verwerfen?"
      confirmLabel="Änderungen verwerfen"
      cancelLabel="Weiter bearbeiten"
      danger
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const run = pending?.run;
        setPending(null);
        run?.();
      }}
    >
      <p>
        Die Änderungen an {subject ?? 'diesem Eintrag'} sind noch nicht gespeichert. Beim Verwerfen bleibt der Eintrag
        so, wie er zuletzt gespeichert wurde.
      </p>
    </ConfirmDialog>
  );

  return { afterDiscard, dialog };
}
