'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import { receiptStore } from '@/lib/receipt-store';
import type { FileInfo } from '@/lib/storage';

export default function Home() {
  const router = useRouter();

  const handleUploadComplete = useCallback((file: FileInfo) => {
    receiptStore.addReceipt(file);
    router.push('/dashboard');
  }, [router]);

  return (
    <main className="min-h-screen py-12 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Receipt OCR
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Upload receipts and invoices to instantly extract text using AI-powered OCR.
            Powered by{' '}
            <a
              href="https://github.com/marlinjai/storage-brain"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Storage Brain
            </a>
            .
          </p>
          <Link
            href="/dashboard"
            className="inline-block mt-4 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
          >
            View Dashboard
          </Link>
        </div>

        {/* Upload */}
        <ReceiptUploader onUploadComplete={handleUploadComplete} />

        {/* Footer */}
        <footer className="mt-16 text-center text-sm text-gray-500">
          <p>
            Built with{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              @marlinjai/storage-brain-sdk
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
