const SENSITIVE_NAME = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|password|passwd|secret|private[_-]?key|client[_-]?secret|credential|cookie|session|connection[_-]?string)(?:$|[_-])/i;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name.trim());
}

/** Removes common credential forms before text is written to local audit logs. */
export function redactSecrets(input: string): string {
  let text = input;
  text = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED PRIVATE KEY]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/^([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIALS?))=(.*)$/gim, '$1=[REDACTED]');
  text = text.replace(/(https?:\/\/)[^\/\s@]+@/gi, '$1[REDACTED]@');
  text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|private[_-]?key|client[_-]?secret|credential|cookie|connection[_-]?string)\b["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi, '$1$2[REDACTED]$2');
  text = text.replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|private[_-]?key|client[_-]?secret|credential|cookie|connection[_-]?string)\b["']?\s*[:=]\s*)([^\s,;{}\[\]]+)/gi, '$1[REDACTED]');
  text = text.replace(/(\B--?(?:token|password|secret|api[_-]?key)\s+)([^\s]+)/gi, '$1[REDACTED]');
  return text.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED KEY]');
}

export interface SensitiveReadDecision {
  tier: 'confirm' | 'never';
  reason: string;
}

/** Serializes a structured value for user-facing or durable display without leaking credentials. */
const MAX_REDACTED_JSON_CHARS = 12_000;

export function redactJson(value: unknown): string {
  let serialized: string;
  try {
    const json = JSON.stringify(redactDisplayValue(value), null, 2);
    serialized = json === undefined ? String(value) : json;
  } catch {
    serialized = String(value);
  }
  const redacted = redactSecrets(serialized);
  if (redacted.length <= MAX_REDACTED_JSON_CHARS) return redacted;
  const marker = '\n…[details truncated]';
  return redacted.slice(0, Math.max(0, MAX_REDACTED_JSON_CHARS - marker.length)) + marker;
}

/** Serializes structured data for durable storage without turning redaction markers into invalid JSON. */
export function redactJsonForStorage(
  value: unknown,
  fallback = '{}',
  maximumChars = 400_000,
): string {
  if (!Number.isSafeInteger(maximumChars) || maximumChars < 1) return fallback;
  try {
    const budget: StoredRedactionBudget = { remaining: maximumChars, exceeded: false };
    const safe = redactStructuredValue(value, 0, budget);
    const serialized = JSON.stringify(safe);
    if (budget.exceeded || typeof serialized !== 'string') return fallback;
    if (Buffer.byteLength(serialized, 'utf8') > maximumChars) return fallback;
    JSON.parse(serialized);
    return serialized;
  } catch {
    return fallback;
  }
}

const STORED_SENSITIVE_NAME =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|private[_-]?key|client[_-]?secret|credential|connection[_-]?string|session[_-]?token|signature|hmac)/i;
const MAX_STORED_VALUE_DEPTH = 8;
const MAX_STORED_VALUE_ENTRIES = 128;
const MAX_STORED_VALUE_KEY_CHARS = 200;
const MAX_DISPLAY_VALUE_NODES = 512;
const MAX_DISPLAY_VALUE_STRING_CHARS = 4_000;

interface StoredRedactionBudget {
  remaining: number;
  exceeded: boolean;
}

function storedMarker(budget: StoredRedactionBudget): string {
  const marker = '[REDACTED]';
  if (marker.length > budget.remaining) budget.exceeded = true;
  budget.remaining = Math.max(0, budget.remaining - marker.length);
  return marker;
}

function storedText(value: string, budget: StoredRedactionBudget): string {
  const available = Math.max(0, budget.remaining);
  const clipped = value.length > available;
  const text = clipped ? value.slice(0, available) : value;
  if (clipped) budget.exceeded = true;
  budget.remaining = Math.max(0, budget.remaining - text.length);
  return redactSecrets(text);
}

function storedKey(value: string, budget: StoredRedactionBudget): string {
  const clipped = value.length > MAX_STORED_VALUE_KEY_CHARS;
  const text = clipped ? value.slice(0, MAX_STORED_VALUE_KEY_CHARS) : value;
  if (clipped) budget.exceeded = true;
  budget.remaining = Math.max(0, budget.remaining - text.length);
  return text;
}

function redactDisplayValue(
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_DISPLAY_VALUE_NODES },
): unknown {
  if (depth >= MAX_STORED_VALUE_DEPTH || budget.remaining-- <= 0) return '[REDACTED]';
  if (typeof value === 'string') {
    const marker = '\n...[details truncated]';
    const bounded = value.length > MAX_DISPLAY_VALUE_STRING_CHARS
      ? value.slice(0, Math.max(0, MAX_DISPLAY_VALUE_STRING_CHARS - marker.length)) + marker
      : value;
    return redactSecrets(bounded);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const entry of value) {
      if (output.length >= MAX_STORED_VALUE_ENTRIES || budget.remaining <= 0) break;
      output.push(redactDisplayValue(entry, depth + 1, budget));
    }
    return output;
  }
  if (typeof value !== 'object') return '[REDACTED]';

  const output: Record<string, unknown> = {};
  let count = 0;
  for (const key in value as Record<string, unknown>) {
    if (count >= MAX_STORED_VALUE_ENTRIES || budget.remaining <= 0) break;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    const safeKey = key.slice(0, 200);
    output[safeKey] = STORED_SENSITIVE_NAME.test(key)
      ? '[REDACTED]'
      : redactDisplayValue((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  return output;
}

function redactStructuredValue(
  value: unknown,
  depth = 0,
  budget: StoredRedactionBudget = { remaining: 400_000, exceeded: false },
): unknown {
  if (depth >= MAX_STORED_VALUE_DEPTH) {
    budget.exceeded = true;
    return storedMarker(budget);
  }
  if (typeof value === 'string') return storedText(value, budget);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index >= MAX_STORED_VALUE_ENTRIES || budget.remaining <= 0) {
        budget.exceeded = true;
        break;
      }
      output.push(redactStructuredValue(value[index], depth + 1, budget));
    }
    return output;
  }
  if (typeof value !== 'object') return storedMarker(budget);

  const output: Record<string, unknown> = {};
  let count = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (count >= MAX_STORED_VALUE_ENTRIES || budget.remaining <= 0) {
      budget.exceeded = true;
      break;
    }
    count += 1;
    const safeKey = storedKey(key, budget);
    output[safeKey] = STORED_SENSITIVE_NAME.test(key)
      ? storedMarker(budget)
      : redactStructuredValue((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  return output;
}

const NEVER_READ_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.docker)(?:[\\/]|$)/i, reason: 'is inside a private credentials directory' },
  { re: /(?:^|[\\/])(?:Cookies?|Login Data|Local State|Web Data)(?:$|[\\/\\s"'])/i, reason: 'is a browser credential or session store' },
  { re: /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/\\s"']+\.(?:pem|pfx|p12|key))(?:$|[\\/\\s"'])/i, reason: 'is a private key or certificate file' },
];

const CONFIRM_READ_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(?:^|[\\/])\.env(?:\.[^\\/\\s"']+)?(?:$|[\\/\\s"'])/i, reason: 'looks like an environment file that may contain secrets' },
  { re: /(?:^|[\\/])(?:credentials?|secrets?|tokens?)(?:\.[^\\/\\s"']+)?(?:$|[\\/\\s"'])/i, reason: 'looks like a secret-bearing file or directory' },
  { re: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|cookie)\b/i, reason: 'mentions a secret or credential' },
];

export function sensitiveRead(value: string): SensitiveReadDecision | null {
  const text = value.trim().replace(/^['"]|['"]$/g, '');
  if (!text) return null;
  if (/(?:\$env:|(?:Get-ChildItem|gci|dir|type|cat|gc)\s+env:)/i.test(text)) {
    return { tier: 'confirm', reason: 'reads environment variables, which may contain secrets.' };
  }
  if (/\b(?:Get-Credential|ConvertFrom-SecureString|vaultcmd|cmdkey)\b/i.test(text)) {
    return { tier: 'never', reason: 'accesses stored credentials.' };
  }
  for (const { re, reason } of NEVER_READ_PATTERNS) {
    if (re.test(text)) return { tier: 'never', reason };
  }
  for (const { re, reason } of CONFIRM_READ_PATTERNS) {
    if (re.test(text)) return { tier: 'confirm', reason };
  }
  return null;
}
