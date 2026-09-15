import { MAX_MODEL_NAME_CHARS } from './stream-limits';

/** Keep hand-added provider ids from becoming an unbounded persisted catalogue. */
export const MAX_CUSTOM_MODELS = 100;
export const MAX_REMOTE_MODELS = 200;

export function normaliseModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > MAX_MODEL_NAME_CHARS) return undefined;
  return clean;
}

export function normaliseRemoteModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_REMOTE_MODELS)) {
    const rawId = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as { id?: unknown }).id : undefined;
    const id = normaliseModelId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normaliseCustomModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = normaliseModelId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_CUSTOM_MODELS) break;
  }
  return ids;
}
