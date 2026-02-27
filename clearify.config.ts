import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Receipt OCR App',
  siteUrl: 'https://docs.receipts.lumitra.co',
  links: {
    app: 'https://receipts.lumitra.co',
  },
  sections: [
    { label: 'Documentation', docsDir: './docs/public' },
    { label: 'Internal', docsDir: './docs/internal', basePath: '/internal', draft: true },
  ],
  mermaid: {
    strategy: 'client',
  },
});
