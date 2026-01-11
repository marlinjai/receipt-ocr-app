'use client';

import type { FileInfo } from '@/lib/storage';

interface OcrResultsProps {
  file: FileInfo;
  onReset: () => void;
}

export default function OcrResults({ file, onReset }: OcrResultsProps) {
  const ocrData = file.metadata?.ocrData;
  const hasOcrData = ocrData && ocrData.fullText;

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            {file.originalName}
          </h2>
          <p className="text-sm text-gray-500">
            Uploaded {new Date(file.createdAt).toLocaleString()}
          </p>
        </div>
        <button
          onClick={onReset}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Upload Another
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Preview */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="font-medium text-gray-900">Preview</h3>
          </div>
          <div className="p-4">
            {file.fileType.startsWith('image/') ? (
              <img
                src={file.url}
                alt={file.originalName}
                className="w-full h-auto rounded-lg"
              />
            ) : (
              <div className="flex items-center justify-center h-48 bg-gray-100 rounded-lg">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="mt-2 text-sm text-gray-500">PDF Document</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* OCR Results */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <h3 className="font-medium text-gray-900">Extracted Text</h3>
            {ocrData?.confidence && (
              <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                {Math.round(ocrData.confidence * 100)}% confidence
              </span>
            )}
          </div>
          <div className="p-4">
            {hasOcrData ? (
              <div className="space-y-4">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono bg-gray-50 p-4 rounded-lg max-h-96 overflow-auto">
                  {ocrData.fullText}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(ocrData.fullText)}
                  className="w-full px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                >
                  Copy to Clipboard
                </button>
              </div>
            ) : (
              <div className="text-center py-8">
                <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="mt-2 text-sm text-gray-500">
                  {file.processingStatus === 'processing'
                    ? 'OCR processing in progress...'
                    : file.processingStatus === 'failed'
                    ? 'OCR processing failed'
                    : 'No text extracted'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* File Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="font-medium text-gray-900">File Details</h3>
        </div>
        <div className="p-4">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">File ID</dt>
              <dd className="font-mono text-gray-900 truncate">{file.id}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Type</dt>
              <dd className="text-gray-900">{file.fileType}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Size</dt>
              <dd className="text-gray-900">{formatBytes(file.sizeBytes)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  file.processingStatus === 'completed'
                    ? 'bg-green-100 text-green-700'
                    : file.processingStatus === 'processing'
                    ? 'bg-yellow-100 text-yellow-700'
                    : file.processingStatus === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-700'
                }`}>
                  {file.processingStatus}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
