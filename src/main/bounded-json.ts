const MAX_JSON_DEPTH = 64;

function hasJsonStringMarkers(value: string): boolean {
  return value.includes('"') || value.includes('\\') || /[\x00-\x1f]/.test(value);
}

function jsonStringBytes(value: string, limit: number): number {
  let bytes = Buffer.byteLength(value, 'utf8') + 2;
  if (bytes > limit) return limit + 1;
  if (!hasJsonStringMarkers(value)) return bytes;

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) bytes += 1;
    else if (code <= 0x1f) bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 1 : 5;
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

function add(total: number, next: number, limit: number): number {
  const value = total + next;
  return value > limit ? limit + 1 : value;
}

/** Counts JSON bytes without invoking toJSON or materializing a JSON string. */
export function estimateJsonBytes(value: unknown, limit = Number.MAX_SAFE_INTEGER): number {
  return estimateValue(value, limit, new Set<object>(), 0);
}

function estimateValue(value: unknown, limit: number, stack: Set<object>, depth: number): number {
  if (depth > MAX_JSON_DEPTH) throw new Error('JSON value exceeded the supported nesting depth.');
  if (typeof value === 'string') return jsonStringBytes(value, limit);
  if (value === null) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON value contains a non-finite number.');
    return String(value).length;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 0;
  if (typeof value === 'bigint') throw new Error('JSON value contains a bigint.');
  if (typeof value !== 'object') return jsonStringBytes(String(value), limit);
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) throw new Error('JSON value contains a toJSON hook.');
  if (stack.has(value)) throw new Error('JSON value contains a cyclic reference.');

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > Math.floor(limit / 2)) return limit + 1;
      let total = 2;
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        const entryBytes = entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
          ? 4
          : estimateValue(entry, Math.max(0, limit - total), stack, depth + 1);
        total = add(total, entryBytes, limit);
        if (index > 0) total = add(total, 1, limit);
        if (total > limit) return limit + 1;
      }
      return total;
    }

    let total = 2;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const keyBytes = jsonStringBytes(key, Math.max(0, limit - total));
      if (add(add(total, keyBytes, limit), 2, limit) > limit) return limit + 1;
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      total = add(total, keyBytes, limit);
      total = add(total, 1, limit);
      total = add(total, estimateValue(entry, Math.max(0, limit - total), stack, depth + 1), limit);
      total = add(total, 1, limit);
      if (total > limit) return limit + 1;
    }
    return total;
  } finally {
    stack.delete(value);
  }
}

export function assertJsonWithinLimit(value: unknown, maximumBytes: number, label = 'JSON value'): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('JSON limit is invalid.');
  const bytes = estimateJsonBytes(value, maximumBytes);
  if (bytes > maximumBytes) throw new Error(label + ' exceeded ' + maximumBytes.toLocaleString() + ' bytes before serialization.');
}

function cloneJsonValue(
  value: unknown,
  stack: Set<object>,
  depth: number,
  inArray: boolean,
): unknown {
  if (depth > MAX_JSON_DEPTH) throw new Error('JSON value exceeded the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return inArray ? null : undefined;
  if (typeof value === 'bigint') throw new Error('JSON value contains a bigint.');
  if (typeof value !== 'object') return String(value);
  if (Object.prototype.hasOwnProperty.call(value, 'toJSON')) throw new Error('JSON value contains a toJSON hook.');
  if (stack.has(value)) throw new Error('JSON value contains a cyclic reference.');

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        output.push(cloneJsonValue(value[index], stack, depth + 1, true));
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const cloned = cloneJsonValue((value as Record<string, unknown>)[key], stack, depth + 1, false);
      if (cloned !== undefined) output[key] = cloned;
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

/** Serializes only after the non-materializing preflight has accepted the value. */
export function stringifyJsonWithinLimit(
  value: unknown,
  maximumBytes: number,
  label = 'JSON value',
  space?: string | number,
): string {
  assertJsonWithinLimit(value, maximumBytes, label);
  const safeValue = cloneJsonValue(value, new Set<object>(), 0, false);
  const serialized = JSON.stringify(safeValue, null, space);
  if (typeof serialized !== 'string') throw new TypeError('Cannot serialize an undefined JSON value.');
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error(label + ' exceeded ' + maximumBytes.toLocaleString() + ' bytes after serialization.');
  }
  return serialized;
}
