import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { throwIfAborted } from './abort';
import { protectedPathReason } from './permissions';
import { sensitiveRead, type SensitiveReadDecision } from './redaction';

type PathDecision = {
  tier: 'confirm' | 'never';
  reason: string;
  requiresExplicitConfirmation?: boolean;
};

const MUTATION_PATH_KEYS: Record<string, readonly string[]> = {
  write_file: ['path'],
  edit_file: ['path'],
  append_file: ['path'],
  create_folder: ['path'],
  delete_item: ['path'],
  move_item: ['from', 'to'],
  copy_item: ['from', 'to'],
  compress: ['source', 'destination'],
  extract: ['archive', 'destination'],
  download_file: ['destination'],
  resize_image: ['source', 'destination'],
  convert_image: ['source', 'destination'],
  crop_image: ['source', 'destination'],
  replace_in_files: ['root'],
  create_shortcut: ['target', 'shortcutPath'],
  chrome_save_pdf: ['destination'],
};

const CANONICAL_SENSITIVE_PATH_KEYS: Record<string, readonly string[]> = {
  list_dir: ['path'],
  read_file: ['path'],
  read_lines: ['path'],
  read_document: ['path'],
  read_pdf: ['path'],
  view_image: ['path'],
  hash_file: ['path'],
  read_csv: ['path'],
  file_info: ['path'],
  file_tree: ['root'],
  dir_size: ['root'],
  recent_files: ['root'],
  workspace_context: ['root'],
  search_files: ['root'],
  print_file: ['path'],
  set_wallpaper: ['path'],
  open_with: ['path'],
  chrome_upload_file: ['filePath'],
};

// Shell batches may contain mutations even though they do not carry one file path.
const SERIALIZED_TOOL_NAMES = new Set(['run_batch']);

export function isMutationTool(toolName: string): boolean {
  if (toolName === 'undo_mutation') return true;
  return Boolean(MUTATION_PATH_KEYS[toolName]) || SERIALIZED_TOOL_NAMES.has(toolName);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Resolve an existing ancestor before appending missing path segments. This
 * makes a junction or symlink in the middle of a not-yet-created destination
 * visible to the protected-path policy.
 */
async function canonicalExistingAncestor(absolutePath: string): Promise<string> {
  const missing: string[] = [];
  let current = absolutePath;

  while (true) {
    try {
      const canonical = await realpath(current);
      return missing.reduceRight((parent, part) => join(parent, part), canonical);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function pathLabel(key: string): string {
  switch (key) {
    case 'from':
    case 'source':
    case 'archive':
      return 'source';
    case 'to':
    case 'destination':
      return 'destination';
    case 'root':
      return 'root';
    case 'shortcutPath':
      return 'shortcut';
    case 'target':
      return 'target';
    default:
      return key;
  }
}

function sensitivePathDecision(label: string, decision: SensitiveReadDecision): PathDecision {
  return {
    tier: decision.tier,
    reason: 'The ' + label + ' path ' + decision.reason,
    requiresExplicitConfirmation: decision.tier === 'confirm',
  };
}

/**
 * Validate every path a mutation can read from or write to. The check is
 * deliberately fail-closed when the filesystem cannot be resolved.
 *
 * This is a preflight, not a lock: a malicious or racing process could still
 * replace a path after realpath and before the mutation runs.
 */
export async function mutationPathDecisionFor(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PathDecision | null> {
  const keys = MUTATION_PATH_KEYS[toolName];
  if (!keys) return null;

  let explicitSensitive: PathDecision | null = null;

  for (const key of keys) {
    throwIfAborted(signal);
    const value = String(args[key] ?? '').trim();
    const label = pathLabel(key);
    if (!value) {
      return { tier: 'never', reason: 'The ' + label + ' path is missing.' };
    }

    const lexicalProtected = protectedPathReason(value);
    if (lexicalProtected) {
      return { tier: 'never', reason: 'The ' + label + ' path ' + lexicalProtected + '.' };
    }

    const lexicalSensitive = sensitiveRead(value);
    let canonical: string;
    try {
      canonical = await canonicalExistingAncestor(resolve(value));
    } catch (error) {
      const code = errorCode(error);
      return {
        tier: 'never',
        reason:
          'The ' +
          label +
          ' path could not be safely resolved' +
          (code ? ' (' + code + ')' : '') +
          '; the mutation was refused.',
      };
    }
    throwIfAborted(signal);

    const canonicalProtected = protectedPathReason(canonical);
    if (canonicalProtected) {
      return {
        tier: 'never',
        reason: 'The ' + label + ' path resolves into a location that ' + canonicalProtected + '.',
      };
    }

    const canonicalSensitive = sensitiveRead(canonical);
    const sensitive = [lexicalSensitive, canonicalSensitive].find(
      (decision): decision is SensitiveReadDecision => decision?.tier === 'never',
    ) ??
      [lexicalSensitive, canonicalSensitive].find(
        (decision): decision is SensitiveReadDecision => Boolean(decision),
      ) ??
      null;

    if (sensitive?.tier === 'never') {
      return sensitivePathDecision(label, sensitive);
    }
    if (sensitive && !explicitSensitive) {
      explicitSensitive = sensitivePathDecision(label, sensitive);
    }
  }

  return explicitSensitive;
}

export async function mutationPathViolation(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string | null> {
  const decision = await mutationPathDecisionFor(toolName, args, signal);
  return decision?.tier === 'never' ? decision.reason : null;
}

function canonicalSensitiveEntriesFor(
  toolName: string,
  args: Record<string, unknown>,
): { label: string; value: unknown }[] {
  const keys = CANONICAL_SENSITIVE_PATH_KEYS[toolName];
  if (keys) {
    return keys.map((key) => ({ label: pathLabel(key), value: args[key] }));
  }

  switch (toolName) {
    case 'read_files':
      return (Array.isArray(args.paths) ? args.paths : []).map((value, index) => ({
        label: 'file ' + String(index + 1),
        value,
      }));
    case 'diff_files':
      return [
        { label: 'first', value: args.a },
        { label: 'second', value: args.b },
      ];
    default:
      return [];
  }
}

export async function canonicalSensitiveDecisionFor(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PathDecision | null> {
  const entries = canonicalSensitiveEntriesFor(toolName, args);
  if (!entries.length) return null;

  let explicitSensitive: PathDecision | null = null;
  for (const entry of entries) {
    throwIfAborted(signal);
    const value = String(entry.value ?? '').trim();
    if (!value) continue;

    let canonical: string;
    try {
      canonical = await canonicalExistingAncestor(resolve(value));
    } catch (error) {
      const code = errorCode(error);
      return {
        tier: 'never',
        reason:
          'The ' +
          entry.label +
          ' path could not be safely resolved' +
          (code ? ' (' + code + ')' : '') +
          '; the read was refused.',
      };
    }
    throwIfAborted(signal);

    const sensitive = sensitiveRead(canonical);
    if (!sensitive) continue;
    const decision = sensitivePathDecision(entry.label, sensitive);
    if (decision.tier === 'never') return decision;
    if (!explicitSensitive) explicitSensitive = decision;
  }

  return explicitSensitive;
}
