import { defineConfig } from 'clearify';

export default defineConfig({
  name: 'Receipt OCR App',
  siteUrl: 'https://docs.receipts.lumitra.co',
  hubProject: {
    hubUrl: 'https://docs.lumitra.co',
    hubName: 'ERP Suite',
    description: 'Receipt scanning & expense tracking with AI chat',
    status: 'active',
    icon: '🧾',
    tags: ['app', 'ai', 'ocr'],
    group: 'Applications',
  },
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
