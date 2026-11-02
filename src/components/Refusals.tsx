'use client';

import { observer } from 'mobx-react-lite';
import ActionNotice from '@/components/ui/ActionNotice';
import { useAppStore } from '@/stores/provider';

/**
 * A refusal with no row to stand at: a receipt check whose panel was left while the
 * answer was out or whose payment a whole read took off the list, or a list action
 * of the meals page, whose rows carry no message. In the shell, so it reaches the
 * person wherever they are, because they believe the change went through. Stays
 * until it is closed.
 */
const Refusals = observer(function Refusals() {
  const app = useAppStore();
  return app.looseRefusals.map(({ key, who, message }, seq) => (
    <ActionNotice key={key} notice={{ seq, tone: 'danger', text: who ? `${who}: ${message}` : message }} onDismiss={() => app.closeRefusal(key)} />
  ));
});

export default Refusals;
