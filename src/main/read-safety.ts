import { isSensitiveName, sensitiveRead, type SensitiveReadDecision } from './redaction';

const PATH_KEYS: Record<string, string> = {
  list_dir: 'path',
  read_file: 'path',
  read_lines: 'path',
  read_document: 'path',
  read_pdf: 'path',
  view_image: 'path',
  hash_file: 'path',
  read_csv: 'path',
  file_info: 'path',
  file_tree: 'root',
  dir_size: 'root',
  recent_files: 'root',
  workspace_context: 'root',
  base64_encode: 'path',
  search_files: 'root',
  json_query: 'source',
  regex_extract: 'source',
  registry_read: 'key',
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
  set_wallpaper: ['path'],
  print_file: ['path'],
  open_with: ['path'],
  chrome_upload_file: ['filePath'],
};

function one(value: unknown): SensitiveReadDecision | null {
  return sensitiveRead(String(value ?? ''));
}

function many(values: unknown[]): SensitiveReadDecision | null {
  const decisions = values.map(one);
  return decisions.find((d): d is SensitiveReadDecision => d?.tier === 'never') ??
    decisions.find((d): d is SensitiveReadDecision => Boolean(d)) ??
    null;
}

const OUTBOUND_SENSITIVE_HEADER =
  /(?:^|[-_])(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|access[_-]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|credential|private[-_]?key|session(?:[-_]?id)?|signature|hmac)(?:$|[-_])/i;
const OUTBOUND_SECRET_VALUE =
  /-----BEGIN [^-]+-----|(?:^|\b)(?:bearer|basic)\s+\S+|https?:\/\/[^\/\s@]+@|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/i;
const OUTBOUND_QUERY_SECRET =
  /[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)=[^&#\s]+/i;

function outboundHeaderIsSensitive(name: string): boolean {
  return OUTBOUND_SENSITIVE_HEADER.test(name) || isSensitiveName(name);
}

function outboundTextIsSensitive(value: string): boolean {
  const text = value.trim();
  return Boolean(text) &&
    (Boolean(sensitiveRead(text)) || OUTBOUND_SECRET_VALUE.test(text) || OUTBOUND_QUERY_SECRET.test(text));
}

function outboundValueIsSensitive(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') return outboundTextIsSensitive(value);
  if (Array.isArray(value)) {
    return value.slice(0, 128).some((entry) => outboundValueIsSensitive(entry, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 128)
    .some(([key, nested]) =>
      outboundHeaderIsSensitive(key) || isSensitiveName(key) || outboundValueIsSensitive(nested, depth + 1),
    );
}

function outboundDecision(args: Record<string, unknown>, includeBody: boolean): SensitiveReadDecision | null {
  if (
    outboundTextIsSensitive(String(args.url ?? '')) ||
    outboundValueIsSensitive(args.headers) ||
    (includeBody && outboundValueIsSensitive(args.body))
  ) {
    return {
      tier: 'confirm',
      reason: 'Sends credential-like data to an external service; review the destination and data before allowing it.',
    };
  }
  return null;
}

export function sensitiveDecisionFor(
  toolName: string,
  args: Record<string, unknown>,
): SensitiveReadDecision | null {
  const key = PATH_KEYS[toolName];
  if (key) return one(args[key]);

  const mutationKeys = MUTATION_PATH_KEYS[toolName];
  if (mutationKeys) return many(mutationKeys.map((mutationKey) => args[mutationKey]));

  switch (toolName) {
    case 'read_files':
      return many(Array.isArray(args.paths) ? args.paths : []);
    case 'diff_files':
      return many([args.a, args.b]);
    case 'search_text':
      return { tier: 'confirm', reason: 'Searches file contents, which may include secrets.' };
    case 'env_vars':
      return args.name === undefined || isSensitiveName(String(args.name))
        ? { tier: 'confirm', reason: 'Reads environment variables, which may contain secrets.' }
        : { tier: 'confirm', reason: 'Reads an environment variable from the machine.' };
    case 'read_clipboard':
      return { tier: 'confirm', reason: 'Reads the current clipboard, which may contain sensitive text.' };
    case 'run_powershell':
    case 'run_cmd':
      return one(args.command);
    case 'run_batch':
      return many(Array.isArray(args.commands) ? args.commands : []);
    case 'http_request': {
      const method = String(args.method ?? 'GET').toUpperCase();
      return outboundDecision(args, !['GET', 'HEAD'].includes(method));
    }
    default:
      return null;
  }
}
