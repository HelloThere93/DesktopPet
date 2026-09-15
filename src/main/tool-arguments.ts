const MAX_ARGUMENT_DEPTH = 16;
const MAX_OBJECT_ENTRIES = 256;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_STRING_CHARS = 200_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaRecord(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function propertySchemas(schema: JsonSchema): Record<string, JsonSchema> | undefined {
  if (!isRecord(schema.properties)) return undefined;
  const result: Record<string, JsonSchema> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    const property = schemaRecord(value);
    if (property) result[name] = property;
  }
  return result;
}

function argumentError(toolName: string, path: string, detail: string): Error {
  return new Error(`${toolName} argument ${path} ${detail}`);
}

function finiteLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coerceScalar(value: unknown, type: string): unknown {
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value);
  }
  if ((type === 'number' || type === 'integer') && typeof value === 'string') {
    const text = value.trim();
    if (text && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (type === 'boolean' && typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return value;
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonValueEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonValueEqual(left[key], right[key]));
  }
  return false;
}

function assertAllowedValue(toolName: string, path: string, schema: JsonSchema, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !jsonValueEqual(schema.const, value)) {
    throw argumentError(toolName, path, 'does not match the required constant value.');
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValueEqual(candidate, value))) {
    throw argumentError(
      toolName,
      path,
      `must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`,
    );
  }
}

function combineSchemas(base: JsonSchema, branch: JsonSchema, composition: 'anyOf' | 'oneOf' | 'allOf'): JsonSchema {
  // Remove only the composition currently being expanded. A branch may itself
  // contain a nested composition with the same keyword; deleting after the
  // spread silently discarded that valid nested schema.
  const outer = { ...base };
  delete outer[composition];
  const combined: JsonSchema = { ...outer, ...branch };
  const baseProperties = isRecord(outer.properties) ? outer.properties : undefined;
  const branchProperties = isRecord(branch.properties) ? branch.properties : undefined;
  if (baseProperties || branchProperties) {
    combined.properties = { ...(baseProperties ?? {}), ...(branchProperties ?? {}) };
  }
  const required = [
    ...(Array.isArray(outer.required) ? outer.required : []),
    ...(Array.isArray(branch.required) ? branch.required : []),
  ].filter((name): name is string => typeof name === 'string');
  if (required.length) combined.required = [...new Set(required)];
  return combined;
}

function cloneUnknown(toolName: string, value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) throw argumentError(toolName, path, 'is nested too deeply.');
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CHARS) throw argumentError(toolName, path, 'is too long.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw argumentError(toolName, path, 'must be finite.');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw argumentError(toolName, path, 'contains too many items.');
    return value.map((entry, index) => cloneUnknown(toolName, entry, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_ENTRIES) throw argumentError(toolName, path, 'contains too many fields.');
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (DANGEROUS_KEYS.has(key)) throw argumentError(toolName, `${path}.${key}`, 'is not allowed.');
      result[key] = cloneUnknown(toolName, entry, `${path}.${key}`, depth + 1);
    }
    return result;
  }
  throw argumentError(toolName, path, 'contains an unsupported value.');
}

function normaliseValue(
  toolName: string,
  value: unknown,
  schema: JsonSchema,
  path: string,
  depth: number,
): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) throw argumentError(toolName, path, 'is nested too deeply.');

  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    let combined = { ...schema };
    delete combined.allOf;
    for (const candidate of schema.allOf) {
      const branch = schemaRecord(candidate);
      if (!branch) throw argumentError(toolName, path, 'has an invalid allOf schema.');
      combined = combineSchemas(combined, branch, 'allOf');
    }
    return normaliseValue(toolName, value, combined, path, depth + 1);
  }

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const candidates = schema[keyword];
    if (!Array.isArray(candidates) || !candidates.length) continue;
    const matches: unknown[] = [];
    for (const candidate of candidates) {
      const branch = schemaRecord(candidate);
      if (!branch) continue;
      try {
        const normalized = normaliseValue(toolName, value, combineSchemas(schema, branch, keyword), path, depth + 1);
        if (keyword === 'anyOf') return normalized;
        matches.push(normalized);
      } catch {
        // Try the next declared alternative; emit one concise failure below.
      }
    }
    if (keyword === 'oneOf' && matches.length === 1) return matches[0];
    if (keyword === 'oneOf' && matches.length > 1) {
      throw argumentError(toolName, path, 'matches more than one oneOf alternative.');
    }
    throw argumentError(toolName, path, `does not match any ${keyword} alternative.`);
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (declaredTypes.length > 1) {
    for (const candidateType of declaredTypes) {
      try {
        return normaliseValue(toolName, value, { ...schema, type: candidateType }, path, depth + 1);
      } catch {
        // Continue until one declared JSON type accepts the value.
      }
    }
    throw argumentError(toolName, path, `must match one of these types: ${declaredTypes.join(', ')}.`);
  }
  const declaredType = declaredTypes[0];
  const type = declaredType ?? (isRecord(schema.properties) ? 'object' : undefined);
  const next = type ? coerceScalar(value, type) : value;

  if (type === 'string') {
    if (typeof next !== 'string') throw argumentError(toolName, path, 'must be a string.');
    const minimum = finiteLimit(schema.minLength, 0);
    const maximum = Math.min(finiteLimit(schema.maxLength, MAX_STRING_CHARS), MAX_STRING_CHARS);
    if (next.length < minimum) throw argumentError(toolName, path, `must contain at least ${minimum} characters.`);
    if (next.length > maximum) throw argumentError(toolName, path, `must contain at most ${maximum} characters.`);
    if (typeof schema.pattern === 'string') {
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern, 'u');
      } catch {
        throw argumentError(toolName, path, 'uses an invalid schema pattern.');
      }
      if (!pattern.test(next)) throw argumentError(toolName, path, 'does not match the required pattern.');
    }
  } else if (type === 'number' || type === 'integer') {
    if (typeof next !== 'number' || !Number.isFinite(next)) {
      throw argumentError(toolName, path, `must be a finite ${type}.`);
    }
    if (type === 'integer' && !Number.isInteger(next)) throw argumentError(toolName, path, 'must be an integer.');
    if (typeof schema.minimum === 'number' && next < schema.minimum) {
      throw argumentError(toolName, path, `must be at least ${schema.minimum}.`);
    }
    if (typeof schema.maximum === 'number' && next > schema.maximum) {
      throw argumentError(toolName, path, `must be at most ${schema.maximum}.`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && next <= schema.exclusiveMinimum) {
      throw argumentError(toolName, path, `must be greater than ${schema.exclusiveMinimum}.`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && next >= schema.exclusiveMaximum) {
      throw argumentError(toolName, path, `must be less than ${schema.exclusiveMaximum}.`);
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const quotient = next / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient))) {
        throw argumentError(toolName, path, `must be a multiple of ${schema.multipleOf}.`);
      }
    }
  } else if (type === 'boolean') {
    if (typeof next !== 'boolean') throw argumentError(toolName, path, 'must be true or false.');
  } else if (type === 'null') {
    if (next !== null) throw argumentError(toolName, path, 'must be null.');
  } else if (type === 'array') {
    if (!Array.isArray(next)) throw argumentError(toolName, path, 'must be an array.');
    const minimum = finiteLimit(schema.minItems, 0);
    const maximum = Math.min(finiteLimit(schema.maxItems, MAX_ARRAY_ITEMS), MAX_ARRAY_ITEMS);
    if (next.length < minimum) throw argumentError(toolName, path, `must contain at least ${minimum} items.`);
    if (next.length > maximum) throw argumentError(toolName, path, `must contain at most ${maximum} items.`);
    const itemSchema = schemaRecord(schema.items);
    const array = itemSchema
      ? next.map((entry, index) => normaliseValue(toolName, entry, itemSchema, `${path}[${index}]`, depth + 1))
      : next.map((entry, index) => cloneUnknown(toolName, entry, `${path}[${index}]`, depth + 1));
    if (schema.uniqueItems === true) {
      for (let index = 0; index < array.length; index += 1) {
        if (array.slice(0, index).some((entry) => jsonValueEqual(entry, array[index]))) {
          throw argumentError(toolName, `${path}[${index}]`, 'duplicates an earlier item.');
        }
      }
    }
    assertAllowedValue(toolName, path, schema, array);
    return array;
  } else if (type === 'object') {
    if (!isRecord(next)) throw argumentError(toolName, path, 'must be an object.');
    const entries = Object.entries(next);
    if (entries.length > MAX_OBJECT_ENTRIES) throw argumentError(toolName, path, 'contains too many fields.');
    const properties = propertySchemas(schema);
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [];
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(next, name) || next[name] === undefined) {
        throw argumentError(toolName, `${path}.${name}`, 'is required.');
      }
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (DANGEROUS_KEYS.has(key)) throw argumentError(toolName, `${path}.${key}`, 'is not allowed.');
      const childSchema = properties?.[key];
      const additionalSchema = schemaRecord(schema.additionalProperties);
      if (properties && !childSchema && schema.additionalProperties !== true && !additionalSchema) {
        throw argumentError(toolName, `${path}.${key}`, 'is not a supported field.');
      }
      if (entry !== undefined) {
        result[key] = childSchema
          ? normaliseValue(toolName, entry, childSchema, `${path}.${key}`, depth + 1)
          : additionalSchema
            ? normaliseValue(toolName, entry, additionalSchema, `${path}.${key}`, depth + 1)
          : cloneUnknown(toolName, entry, `${path}.${key}`, depth + 1);
      }
    }
    if (typeof schema.minProperties === 'number' && entries.length < schema.minProperties) {
      throw argumentError(toolName, path, `must contain at least ${schema.minProperties} fields.`);
    }
    if (typeof schema.maxProperties === 'number' && entries.length > schema.maxProperties) {
      throw argumentError(toolName, path, `must contain at most ${schema.maxProperties} fields.`);
    }
    assertAllowedValue(toolName, path, schema, result);
    return result;
  } else {
    return cloneUnknown(toolName, next, path, depth);
  }

  assertAllowedValue(toolName, path, schema, next);
  return next;
}

/**
 * Validates and safely normalizes one model-generated tool argument object.
 * Common scalar slips ("12" for a number, "false" for a boolean) are repaired
 * before approval; missing, unknown, dangerous, or structurally invalid values
 * are rejected before a tool can observe them.
 */
export function normalizeToolArguments(
  toolName: string,
  rawArgs: unknown,
  parameterSchema: JsonSchema,
): Record<string, unknown> {
  if (!isRecord(rawArgs)) throw argumentError(toolName, '$', 'must be an object.');
  if (Object.prototype.hasOwnProperty.call(rawArgs, '__parseError')) {
    throw argumentError(toolName, '$', 'was not valid JSON.');
  }
  const normalized = normaliseValue(toolName, rawArgs, parameterSchema, '$', 0);
  if (!isRecord(normalized)) throw argumentError(toolName, '$', 'must be an object.');
  return normalized;
}
