import { auth } from '@/lib/auth';

/**
 * Public page shown to a VERIFIED auth-brain session whose tenants hold no
 * `receipts` app grant (so it matches zero workspaces). Bouncing such a session
 * to login would loop (the session is valid); an explicit dead-end with a next
 * action is the fix.
 */
export default function NoAccessPage() {
  return (
    <main className="relative z-10 min-h-screen flex items-center justify-center px-4">
      <div className="glass-panel max-w-md w-full rounded-xl p-8 text-center">
        <h1 className="text-2xl font-bold mb-3" style={{ color: 'var(--foreground)' }}>
          No access to Receipts
        </h1>
        <p className="text-sm leading-relaxed mb-6" style={{ color: 'var(--muted)' }}>
          Your account is signed in, but none of your companies has Receipts
          enabled. Ask Marlin to enable the Receipts app for your company in the
          auth-brain console (and add your email to its workspace), then reload
          this page.
        </p>
        <a
          href={auth.logoutUrl()}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
        >
          Sign out and switch account
        </a>
      </div>
    </main>
  );
}
