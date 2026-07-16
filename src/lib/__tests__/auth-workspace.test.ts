import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  sessionMayAccessWorkspace,
  sessionWorkspaceId,
  devFallbackWorkspaceId,
  workspaceLabel,
  type SessionLike,
} from '../auth-workspace';

afterEach(() => vi.unstubAllEnvs());

const WS_LOLA = { id: 'ws_lola', slug: 'receipts-lola-stories', role: 'member' };
const WS_MJ = { id: 'ws_mj', slug: 'receipts-marlinjai', role: 'member' };

function session(overrides: Partial<SessionLike> = {}): SessionLike {
  return { memberships: [WS_LOLA, WS_MJ], activeWorkspace: WS_LOLA, ...overrides };
}

describe('sessionMayAccessWorkspace', () => {
  it('allows a member workspace', () => {
    expect(sessionMayAccessWorkspace(session(), 'ws_mj')).toBe(true);
  });

  it('DENIES a non-member workspace (cross-company isolation, fail-closed)', () => {
    expect(sessionMayAccessWorkspace(session(), 'ws_other_company')).toBe(false);
  });

  it('scopes the dev bypass (no memberships) to ONLY the local dev workspace', () => {
    const dev = session({ memberships: [], activeWorkspace: null });
    expect(sessionMayAccessWorkspace(dev, 'receipt-ocr')).toBe(true);
    expect(sessionMayAccessWorkspace(dev, 'ws_lola')).toBe(false);
  });
});

describe('sessionWorkspaceId', () => {
  it('returns the VALIDATED active workspace id', () => {
    expect(sessionWorkspaceId(session())).toBe('ws_lola');
    expect(sessionWorkspaceId(session({ activeWorkspace: WS_MJ }))).toBe('ws_mj');
  });

  it('falls back to the local dev workspace for the bypass session', () => {
    expect(sessionWorkspaceId(session({ memberships: [], activeWorkspace: null }))).toBe(
      'receipt-ocr',
    );
  });

  it('honors AUTH_DEV_WORKSPACE_ID for the bypass fallback', () => {
    vi.stubEnv('AUTH_DEV_WORKSPACE_ID', 'my-dev-ws');
    expect(devFallbackWorkspaceId()).toBe('my-dev-ws');
    expect(sessionWorkspaceId(session({ memberships: [], activeWorkspace: null }))).toBe(
      'my-dev-ws',
    );
  });
});

describe('workspaceLabel', () => {
  it('prettifies receipts-<company> slugs', () => {
    expect(workspaceLabel('receipts-lola-stories')).toBe('Lola Stories');
    expect(workspaceLabel('receipts-marlinjai')).toBe('Marlinjai');
    expect(workspaceLabel('receipts-lumitra')).toBe('Lumitra');
  });
});
