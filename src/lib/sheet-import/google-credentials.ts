import 'server-only';
import { prisma } from '@/lib/prisma';
import { encryptToken, decryptToken } from './token-crypto';
import { refreshAccessToken } from './google-oauth';
import { loadGoogleOAuthClient, tokenEncryptionKey } from './google-config';

/**
 * Per-user Google credential store. The refresh token is sealed (AES-256-GCM)
 * before it touches the DB and only decrypted in-process to mint short-lived
 * access tokens. Keyed by the auth-brain user id, so a user's Google connection
 * follows them across every receipts workspace they belong to.
 */

export async function saveGoogleCredential(input: {
  authUserId: string;
  refreshToken: string;
  scopes: string;
  googleEmail?: string | null;
}): Promise<void> {
  const sealed = encryptToken(input.refreshToken, tokenEncryptionKey());
  await prisma.googleSheetsCredential.upsert({
    where: { authUserId: input.authUserId },
    create: {
      authUserId: input.authUserId,
      refreshTokenEncrypted: sealed,
      scopes: input.scopes,
      googleEmail: input.googleEmail ?? null,
    },
    update: {
      refreshTokenEncrypted: sealed,
      scopes: input.scopes,
      googleEmail: input.googleEmail ?? null,
    },
  });
}

/** Non-secret connection status for the UI (never returns the token). */
export async function getGoogleConnection(
  authUserId: string,
): Promise<{ googleEmail: string | null; scopes: string } | null> {
  return prisma.googleSheetsCredential.findUnique({
    where: { authUserId },
    select: { googleEmail: true, scopes: true },
  });
}

export async function disconnectGoogle(authUserId: string): Promise<void> {
  await prisma.googleSheetsCredential.deleteMany({ where: { authUserId } });
}

/**
 * A fresh access token for the user, or null if they haven't connected Google.
 * Decrypts the stored refresh token and exchanges it every call (tokens are
 * short-lived; caching is a later optimization, not correctness).
 */
export async function getAccessTokenForUser(authUserId: string): Promise<string | null> {
  const cred = await prisma.googleSheetsCredential.findUnique({ where: { authUserId } });
  if (!cred) return null;
  const refreshToken = decryptToken(cred.refreshTokenEncrypted, tokenEncryptionKey());
  const client = loadGoogleOAuthClient();
  const tokens = await refreshAccessToken({
    refreshToken,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  return tokens.access_token;
}
