import { StorageBrain } from '@marlinjai/storage-brain-sdk';

let _client: StorageBrain | null = null;

export function getStorageClient() {
  if (_client) return _client;

  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    throw new Error('STORAGE_BRAIN_API_KEY is not set');
  }

  const base = new StorageBrain({
    apiKey,
    baseUrl: process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co',
  });

  const workspaceId = process.env.NEXT_PUBLIC_STORAGE_BRAIN_WORKSPACE_ID;
  _client = workspaceId ? base.withWorkspace(workspaceId) : base;
  return _client;
}

export type { FileInfo, FileMetadata, Workspace } from '@marlinjai/storage-brain-sdk';
