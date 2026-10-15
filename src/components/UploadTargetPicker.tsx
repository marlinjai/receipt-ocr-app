'use client';

import { useId } from 'react';
import type { UploadTarget } from '@/lib/auth-workspace';

interface UploadTargetPickerProps {
  targets: UploadTarget[];
  workspaceId: string;
  onChange: (workspaceId: string) => void;
}

/**
 * Says which company the uploads of this page go into, and lets the user pick
 * another one of theirs. Picking here changes only this page: the session's
 * active company (and with it every other tab) stays as it is.
 */
export default function UploadTargetPicker({ targets, workspaceId, onChange }: UploadTargetPickerProps) {
  const id = useId();
  const current = targets.find((t) => t.workspaceId === workspaceId);
  if (!current) return null;
  return (
    <div className="glass-panel rounded-lg px-4 py-3 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <label htmlFor={id} style={{ color: 'var(--muted)' }}>
        Upload into
      </label>
      {targets.length > 1 ? (
        <select
          id={id}
          value={workspaceId}
          onChange={(e) => onChange(e.target.value)}
          className="glass-panel rounded-lg px-3 py-1.5 text-sm font-medium outline-none text-[color:var(--foreground)] bg-[color:var(--background)]"
        >
          {targets.map((t) => (
            <option key={t.workspaceId} value={t.workspaceId}>
              {t.label}
            </option>
          ))}
        </select>
      ) : (
        <output id={id} className="font-semibold" style={{ color: 'var(--foreground)' }}>
          {current.label}
        </output>
      )}
    </div>
  );
}
