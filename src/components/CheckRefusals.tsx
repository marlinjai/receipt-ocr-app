'use client';

import { observer } from 'mobx-react-lite';
import ActionNotice from '@/components/ui/ActionNotice';
import { useAppStore } from '@/stores/provider';

/**
 * A refusal of the receipt checks with no row to stand at: the panel was left
 * while the answer was out, or a whole read took the payment off the list. In
 * the shell, so it reaches the person wherever they are, because they believe
 * the change went through. Stays until it is closed.
 */
const CheckRefusals = observer(function CheckRefusals() {
  const app = useAppStore();
  return app.looseRefusals.map(({ key, who, message }, seq) => (
    <ActionNotice key={key} notice={{ seq, tone: 'danger', text: who ? `${who}: ${message}` : message }} onDismiss={() => app.checkOutbox.clear(key)} />
  ));
});

export default CheckRefusals;
