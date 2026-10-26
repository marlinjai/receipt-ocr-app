/**
 * Shown while a page of the app is loaded on the server (the dashboard and
 * the spending page take a few seconds). Without it a click on a link changes
 * nothing on screen until the new page is there, which reads as a dead link.
 * The header of the layout stays; only the page below it is replaced. Static:
 * nothing moves.
 */
export default function AppLoading() {
  return (
    <main className="relative z-10 min-h-svh px-4 pb-24 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <p role="status" className="glass-panel mt-6 rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Wird geladen…
        </p>
      </div>
    </main>
  );
}
