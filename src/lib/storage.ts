import { StorageBrain } from '@marlinjai/storage-brain-sdk';

export function getStorageClient() {
  const apiKey = process.env.NEXT_PUBLIC_STORAGE_BRAIN_API_KEY;

  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_STORAGE_BRAIN_API_KEY is not set');
  }

  return new StorageBrain({
    apiKey,
    baseUrl: process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev',
  });
}

export type { FileInfo, FileMetadata } from '@marlinjai/storage-brain-sdk';
