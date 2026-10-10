/** Shown while the contacts are loaded on the server. Static: nothing moves. */
export default function ContactsLoading() {
  return (
    <main className="relative z-10 min-h-svh px-4 pb-24 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
          Kontakte
        </h1>
        <p role="status" className="glass-panel mt-6 rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Kontakte werden geladen…
        </p>
      </div>
    </main>
  );
}
