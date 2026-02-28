import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="relative z-10 min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="glass-nav sticky top-0 z-50 w-full max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--accent-muted)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>
            Receipt OCR
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="https://docs.receipts.lumitra.co"
            className="text-sm transition-colors"
            style={{ color: 'var(--muted)' }}
          >
            Docs
          </a>
          <a
            href="https://github.com/marlinjai/receipt-ocr-app"
            className="text-sm transition-colors"
            style={{ color: 'var(--muted)' }}
          >
            GitHub
          </a>
          <Link
            href="/app"
            className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
            style={{
              background: 'var(--accent)',
              color: 'var(--background)',
            }}
          >
            Open App
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 pb-16 pt-8">
        <div className="text-center max-w-2xl mx-auto">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase mb-8"
            style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            Powered by AI
          </div>

          <h1
            className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1] mb-6"
            style={{ color: 'var(--foreground)' }}
          >
            Turn Receipts Into{' '}
            <span style={{ color: 'var(--accent)' }}>Structured Data</span>
          </h1>

          <p
            className="text-lg leading-relaxed max-w-lg mx-auto mb-10"
            style={{ color: 'var(--muted)' }}
          >
            Upload receipts and invoices. Get vendor, amounts, dates, and categories extracted automatically with Google Cloud Vision OCR.
          </p>

          <div className="flex items-center justify-center gap-4">
            <Link
              href="/app"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold transition-all duration-200"
              style={{
                background: 'var(--accent)',
                color: 'var(--background)',
              }}
            >
              Start Scanning
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Link>
            <a
              href="https://docs.receipts.lumitra.co"
              className="glass-panel inline-flex items-center gap-2 px-6 py-3 rounded-lg text-sm font-medium transition-all duration-200"
              style={{
                color: 'var(--foreground)',
              }}
            >
              Read the Docs
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="w-full max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[
            {
              title: 'OCR Extraction',
              description: 'Google Cloud Vision reads every line of text from receipts, invoices, and documents with high accuracy.',
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              ),
            },
            {
              title: 'Smart Field Extraction',
              description: 'Automatically identifies vendor names, gross/net amounts, tax rates, dates, and expense categories.',
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              ),
            },
            {
              title: 'Expense Dashboard',
              description: 'View, filter, and manage extracted data in a Notion-like table with board and calendar views.',
              icon: (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              ),
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="glass-panel rounded-xl p-6 transition-all duration-200 hover:scale-[1.01]"
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center mb-4"
                style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
              >
                {feature.icon}
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
                {feature.title}
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="w-full max-w-5xl mx-auto px-6 pb-24">
        <h2 className="text-2xl font-bold text-center mb-12" style={{ color: 'var(--foreground)' }}>
          How it works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            { step: '1', title: 'Upload', description: 'Drag and drop a receipt image or PDF into the upload zone.' },
            { step: '2', title: 'Extract', description: 'AI reads the document and extracts vendor, amounts, dates, and categories.' },
            { step: '3', title: 'Manage', description: 'Review extracted data in a searchable, filterable dashboard with multiple views.' },
          ].map((item) => (
            <div key={item.step} className="text-center">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-4 text-sm font-bold"
                style={{ background: 'var(--accent)', color: 'var(--background)', boxShadow: '0 0 20px rgba(226, 163, 72, 0.3), 0 0 6px rgba(226, 163, 72, 0.2)' }}
              >
                {item.step}
              </div>
              <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
                {item.title}
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full border-t py-8 px-6" style={{ borderColor: 'var(--glass-border)' }}>
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Built with{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--muted)' }}
            >
              @marlinjai/storage-brain-sdk
            </a>
            {' '}and{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/data-table-react"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--muted)' }}
            >
              @marlinjai/data-table-react
            </a>
          </p>
          <div className="flex items-center gap-5">
            <a
              href="https://docs.receipts.lumitra.co"
              className="text-xs transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--muted)' }}
            >
              Docs
            </a>
            <a
              href="https://github.com/marlinjai/receipt-ocr-app"
              className="text-xs transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--muted)' }}
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/~marlinjai"
              className="text-xs transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--muted)' }}
            >
              npm
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
