import { StorageBrain } from '@marlinjai/storage-brain-sdk';

let _client: StorageBrain | null = null;

export function getStorageClient() {
  if (_client) return _client;

  const apiKey = process.env.NEXT_PUBLIC_STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_STORAGE_BRAIN_API_KEY is not set');
  }

  const base = new StorageBrain({
    apiKey,
    baseUrl: process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev',
  });

  const workspaceId = process.env.NEXT_PUBLIC_STORAGE_BRAIN_WORKSPACE_ID;
  _client = workspaceId ? base.withWorkspace(workspaceId) : base;
  return _client;
}

export type { FileInfo, FileMetadata, Workspace } from '@marlinjai/storage-brain-sdk';
