import { safeStorage } from 'electron';
import { loadCredential, saveCredential, deleteCredential } from '../db';

const CRED_ID = 'chatgpt-oauth';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

const MAX_TOKEN_CHARS = 16_000;
const MAX_METADATA_CHARS = 1_000;
const MAX_STORED_JSON_BYTES = 80_000;
const MAX_TOKEN_EXPIRY_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= maximum ? text : undefined;
}

function optionalBoundedText(value: unknown, maximum: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, maximum) ?? null;
}

export function normaliseStoredTokens(value: unknown): StoredTokens | null {
  if (!isRecord(value)) return null;
  const accessToken = boundedText(value.accessToken, MAX_TOKEN_CHARS);
  const refreshToken = boundedText(value.refreshToken, MAX_TOKEN_CHARS);
  if (!accessToken || !refreshToken) return null;
  if (
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0 ||
    value.expiresAt > Date.now() + MAX_TOKEN_EXPIRY_AHEAD_MS
  ) {
    return null;
  }
  const idToken = optionalBoundedText(value.idToken, MAX_TOKEN_CHARS);
  const accountId = optionalBoundedText(value.accountId, MAX_METADATA_CHARS);
  const email = optionalBoundedText(value.email, MAX_METADATA_CHARS);
  if (idToken === null || accountId === null || email === null) return null;
  return {
    accessToken,
    refreshToken,
    ...(idToken === undefined ? {} : { idToken }),
    expiresAt: value.expiresAt,
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
  };
}

/**
 * Tokens are encrypted with the OS keystore (DPAPI on Windows) before they
 * touch SQLite, so a copied .sqlite file is useless on another machine.
 */
export function saveTokens(t: StoredTokens): void {
  const normalized = normaliseStoredTokens(t);
  if (!normalized) throw new Error('Refusing to store malformed OAuth tokens.');
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_STORED_JSON_BYTES) {
    throw new Error('OAuth token record exceeded the storage safety limit.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable — refusing to write tokens in plaintext.',
    );
  }
  saveCredential(CRED_ID, safeStorage.encryptString(json));
}

export function loadTokens(): StoredTokens | null {
  const blob = loadCredential(CRED_ID);
  if (!blob) return null;
  try {
    const json = safeStorage.decryptString(blob);
    if (Buffer.byteLength(json, 'utf8') > MAX_STORED_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(json);
    return normaliseStoredTokens(parsed);
  } catch {
    // Corrupt or encrypted under a different OS user — treat as signed out.
    return null;
  }
}

export function clearTokens(): void {
  deleteCredential(CRED_ID);
}
