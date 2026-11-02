'use client';

import { observer } from 'mobx-react-lite';
import ActionNotice from '@/components/ui/ActionNotice';
import { useContext } from 'react';
import { RefusalDeskContext, useAppStore } from '@/stores/provider';

/**
 * A refusal with no row to stand at: a receipt check whose panel was left while the
 * answer was out or whose payment a whole read took off the list, or a list action
 * of the meals page, whose rows carry no message. In the shell, so it reaches the
 * person wherever they are, because they believe the change went through. Stays
 * until it is closed. A refusal of a company the person has left stands here too,
 * always with the name of that company.
 */
const Refusals = observer(function Refusals() {
  const app = useAppStore();
  const desk = useContext(RefusalDeskContext);
  const said = (who: string | null, message: string) => (who ? `${who}: ${message}` : message);
  return (
    <>
      {[...(desk?.refusals.values() ?? [])].map(({ key, company, who, message }, seq) => (
        <ActionNotice key={key} notice={{ seq, tone: 'danger', text: `Firma ${company}: ${said(who, message)}` }} onDismiss={() => desk?.close(key)} />
      ))}
      {app.looseRefusals.map(({ key, who, message }, seq) => (
        <ActionNotice key={key} notice={{ seq, tone: 'danger', text: said(who, message) }} onDismiss={() => app.closeRefusal(key)} />
      ))}
    </>
  );
});

export default Refusals;
