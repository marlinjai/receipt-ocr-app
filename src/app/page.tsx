'use client';

import { useState } from 'react';
import ReceiptUploader from '@/components/ReceiptUploader';
import OcrResults from '@/components/OcrResults';
import type { FileInfo } from '@/lib/storage';

export default function Home() {
  const [uploadedFile, setUploadedFile] = useState<FileInfo | null>(null);

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
        </div>

        {/* Main Content */}
        {uploadedFile ? (
          <OcrResults
            file={uploadedFile}
            onReset={() => setUploadedFile(null)}
          />
        ) : (
          <ReceiptUploader onUploadComplete={setUploadedFile} />
        )}

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
