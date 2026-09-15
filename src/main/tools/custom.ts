import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, opendirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { throwIfAborted } from '../abort';
import { readBoundedTextFileSync } from '../bounded-file';
import { redactSecrets } from '../redaction';
import { runPowerShellStrict } from './shell';
import { runNodeStrict, runPythonStrict } from './dev';
import { stringifyJsonWithinLimit } from '../bounded-json';
import { writeTextFileAtomic } from '../durable-store';
import { appendLessonFile, deleteLessonFile, editLessonFile, lessonsForPromptFromFile, listLessonEntriesFile, listLessonsFile, type LessonListView } from '../lessons';
import { installedSkillTools } from '../skills';
import type { ToolStudioDefinition, ToolStudioParam, ToolStudioSideEffectManifest, ToolStudioSummary, ToolStudioWorkflowStep } from '../../shared/types';

/**
 * Tools that exist at runtime rather than in this repository.
 *
 * Everything else in the app is a tool someone wrote in TypeScript and shipped.
 * These are made while the app is running — by the agent when it notices it is
 * repeating itself, or by the user dropping a script into a folder — and they
 * appear in the model's tool list alongside the built-ins with no restart.
 *
 * Four kinds, because "write me a tool" turns out to mean four different things:
 *
 *   script    a program in PowerShell, Python or Node
 *   http      a call to an API, described rather than coded
 *   workflow  several existing tools run in order, which is composition
 *   folder    a file the user put in tools/scripts, discovered automatically
 *
 * Downloadable capability packs are admitted separately through ../skills.
 * They install disabled, are schema-validated here before becoming callable,
 * and retain the same per-call permissions, cancellation, and auditing.
 */

export type ToolKind = 'script' | 'http' | 'workflow';
export type ToolLanguage = 'powershell' | 'python' | 'node';

export interface ToolParam {
  name: string;
  description: string;
  /** Defaults to string. Typed parameters are checked before the tool runs. */
  type?: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  /** When set, the value must be one of these. */
  choices?: string[];
}

export interface WorkflowStep {
  tool: string;
  args: Record<string, unknown>;
}
export interface SideEffectManifest {
  outputs?: string[];
  effects?: string[];
  reason?: string;
}




export interface CustomTool {
  name: string;
  description: string;
  kind?: ToolKind;
  /** script only. */
  language?: ToolLanguage;
  params: ToolParam[];
  script?: string;
  /** http only. */
  method?: string;
  url?: string;
  sideEffectManifest?: SideEffectManifest;
  headers?: Record<string, string>;
  body?: string;
  /** workflow only. */
  steps?: WorkflowStep[];
  createdAt: string;
  /** 'folder' tools live as real script files the user can edit. */
  source?: 'agent' | 'folder' | 'skill';
  path?: string;
  skillId?: string;
}

export function toolsDir(): string {
  const dir = join(app.getPath('userData'), 'tools');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function scriptsDir(): string {
  const dir = join(toolsDir(), 'scripts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const MAX_CUSTOM_TOOLS = 200;
const MAX_CUSTOM_DISCOVERY_ENTRIES = 2_000;

function boundedDirectoryNames(dir: string, maximum: number): string[] {
  const names: string[] = [];
  const directory = opendirSync(dir);
  try {
    while (names.length < maximum) {
      const entry = directory.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

const MAX_CUSTOM_SCRIPT_BYTES = 500_000;
const MAX_CUSTOM_DEFINITION_BYTES = 200_000;
const MAX_CUSTOM_PARAMS = 40;
const MAX_CUSTOM_CHOICES = 40;
const MAX_CUSTOM_OUTPUT = 40_000;
const MAX_CUSTOM_HTTP_RESPONSE_BYTES = 1_000_000;

const toolUpdateListeners = new Set<() => void>();

export function subscribeToolUpdates(listener: () => void): () => void {
  toolUpdateListeners.add(listener);
  return () => toolUpdateListeners.delete(listener);
}

function notifyToolUpdates(): void {
  for (const listener of toolUpdateListeners) {
    try {
      listener();
    } catch {
      /* A renderer refresh must never break tool persistence. */
    }
  }
}

const MAX_CUSTOM_HTTP_BODY = 100_000;
const MAX_CUSTOM_WORKFLOW_DEPTH = 8;
const MAX_CUSTOM_WORKFLOW_NODES = 512;
const MAX_CUSTOM_WORKFLOW_COLLECTION_ITEMS = 80;
const MAX_CUSTOM_WORKFLOW_ARGUMENT_CHARS = 200_000;
const MAX_CUSTOM_MANIFEST_OUTPUTS = 8;
const MAX_CUSTOM_MANIFEST_EFFECTS = 8;
const MAX_CUSTOM_MANIFEST_OUTPUT_CHARS = 1_000;
const MAX_CUSTOM_MANIFEST_EFFECT_CHARS = 600;

/**
 * Infer omitted script runtimes from strong syntax signals. Explicit language
 * always wins; ambiguous snippets retain the backwards-compatible PowerShell
 * default instead of guessing from one punctuation character.
 */
export function inferToolLanguage(script: string, requested?: ToolLanguage): ToolLanguage {
  if (requested) return requested;
  const source = String(script ?? '');
  const scores: Record<ToolLanguage, number> = { powershell: 0, python: 0, node: 0 };
  const add = (language: ToolLanguage, pattern: RegExp, weight: number): void => {
    if (pattern.test(source)) scores[language] += weight;
  };

  add('python', /^#!.*\bpython(?:\d+(?:\.\d+)*)?\b/im, 8);
  add('python', /^\s*(?:from\s+[A-Za-z_][\w.]*\s+import\s+|import\s+[A-Za-z_][\w.]*)/m, 4);
  add('python', /^\s*def\s+[A-Za-z_]\w*\s*\(/m, 4);
  add('python', /__name__\s*==\s*['"]__main__['"]/, 4);
  add('python', /\bprint\s*\(/, 2);

  add('node', /^#!.*\bnode\b/im, 8);
  add('node', /\brequire\s*\(/, 4);
  add('node', /^\s*import\s+.+\s+from\s+['"]/m, 4);
  add('node', /\b(?:module\.exports|exports\.|process\.|console\.(?:log|error)|JSON\.(?:parse|stringify))/, 3);
  add('node', /^\s*(?:const|let|var)\s+[A-Za-z_$]/m, 2);

  add('powershell', /^#!.*\b(?:pwsh|powershell)\b/im, 8);
  add('powershell', /\$(?:ErrorActionPreference|PSVersionTable)|\bparam\s*\(/i, 4);
  add('powershell', /\b(?:Get|Set|New|Remove|Invoke|Write|Start|Stop|Test|Resolve|Select|Where|ForEach|ConvertTo|ConvertFrom)-[A-Za-z]+\b/i, 3);
  add('powershell', /^\s*\$[A-Za-z_]\w*\s*=/m, 2);

  const ranked = (Object.entries(scores) as Array<[ToolLanguage, number]>)
    .sort((left, right) => right[1] - left[1]);
  const first = ranked[0];
  const second = ranked[1];
  return first && second && first[1] > 0 && first[1] > second[1] ? first[0] : 'powershell';
}

function manifestList(
  value: unknown,
  label: string,
  maximum: number,
  itemMaximum: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Custom side-effect manifest ' + label + ' must be an array.');
  if (value.length > maximum) throw new Error('Custom side-effect manifest may contain at most ' + maximum + ' ' + label + '.');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Custom side-effect manifest ' + label + ' must contain strings.');
    const clean = redactSecrets(item).trim();
    if (!clean || clean.length > itemMaximum || /[\r\n\0]/.test(clean)) {
      throw new Error('Custom side-effect manifest ' + label + ' contains an invalid entry.');
    }
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

function normaliseSideEffectManifest(value: unknown): SideEffectManifest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Custom side-effect manifest must be an object.');
  }
  const record = value as Partial<SideEffectManifest>;
  const outputs = manifestList(record.outputs, 'outputs', MAX_CUSTOM_MANIFEST_OUTPUTS, MAX_CUSTOM_MANIFEST_OUTPUT_CHARS);
  const effects = manifestList(record.effects, 'effects', MAX_CUSTOM_MANIFEST_EFFECTS, MAX_CUSTOM_MANIFEST_EFFECT_CHARS);
  let reason: string | undefined;
  if (record.reason !== undefined) {
    if (typeof record.reason !== 'string') throw new Error('Custom side-effect manifest reason must be a string.');
    reason = redactSecrets(record.reason).trim();
    if (!reason || reason.length > MAX_CUSTOM_MANIFEST_EFFECT_CHARS || /[\r\n\0]/.test(reason)) {
      throw new Error('Custom side-effect manifest reason is invalid.');
    }
  }
  if (!outputs.length && !effects.length) return undefined;
  return {
    ...(outputs.length ? { outputs } : {}),
    ...(effects.length ? { effects } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface ResolvedSideEffectManifest {
  artifactPaths?: string[];
  effects?: string[];
  reason?: string;
}

export function sideEffectManifestFor(
  tool: CustomTool,
  args: Record<string, unknown>,
): ResolvedSideEffectManifest | undefined {
  const manifest = normaliseSideEffectManifest(tool.sideEffectManifest);
  if (!manifest) return undefined;
  const fill = (value: string): string =>
    value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(args[key] ?? ''));
  const resolved = normaliseSideEffectManifest({
    outputs: manifest.outputs?.map(fill),
    effects: manifest.effects?.map(fill),
    reason: manifest.reason ? fill(manifest.reason) : undefined,
  });
  if (!resolved) return undefined;
  return {
    artifactPaths: resolved.outputs,
    effects: resolved.effects,
    reason: resolved.reason,
  };
}
function boundedOutput(text: string, maximum: number, marker: string): string {
  if (text.length <= maximum) return text;
  const suffix = '\n' + marker;
  return text.slice(0, Math.max(0, maximum - suffix.length)).trimEnd() + suffix;
}

function clipped(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : String(value ?? '').slice(0, maximum);
}

function safeClipped(value: unknown, maximum: number): string {
  return redactSecrets(clipped(value, maximum));
}

function requireScriptSize(script: string): string {
  if (script.length > MAX_CUSTOM_SCRIPT_BYTES) throw new Error(`Custom script exceeded the ${MAX_CUSTOM_SCRIPT_BYTES}-character safety limit.`);
  return script;
}

async function cancelHttpResponseBody(response: Pick<Response, 'body'>): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* cleanup must not replace the original validation error */
  }
}
async function readBoundedHttpResponse(response: Response, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    await cancelHttpResponseBody(response);
    throw error;
  }
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const part = await reader.read();
      if (part.done) {
        const tail = decoder.decode();
        if (tail) chunks.push(tail);
        break;
      }
      const remaining = MAX_CUSTOM_HTTP_RESPONSE_BYTES - bytes;
      if (part.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(decoder.decode(part.value.slice(0, remaining), { stream: true }));
        const tail = decoder.decode();
        if (tail) chunks.push(tail);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      bytes += part.value.byteLength;
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return { text: chunks.join(''), truncated };
}

/* -------------------------------------------------------- folder scripts */

const LANG_BY_EXT: Record<string, ToolLanguage> = {
  '.ps1': 'powershell',
  '.py': 'python',
  '.js': 'node',
  '.mjs': 'node',
};

/**
 * Turns a script the user dropped in tools/scripts into a callable tool.
 *
 * The point is that extending the pet should not require asking the agent to
 * write something. A file with a couple of header comments is a tool:
 *
 *   # adi: Renames every file in a folder to lower case
 *   # adi-param: folder - which folder to work in
 *   # adi-param: dry_run (boolean) - list the changes without making them
 *
 * Without the header the file still becomes a tool, just an undocumented one —
 * better than silently ignoring it and leaving the user wondering.
 */
export function parseFolderScriptHeader(
  text: string,
  fallbackName: string,
): { description: string; params: ToolParam[]; sideEffectManifest?: SideEffectManifest } {
  const outputs: string[] = [];
  const effects: string[] = [];
  const lines = text.split(/\r?\n/).slice(0, 40);
  let description = '';
  const params: ToolParam[] = [];

  for (const raw of lines) {
    const line = raw.replace(/^\s*(#|\/\/|<#|rem)\s?/i, '').trim();

    const desc = /^adi:\s*(.+)$/i.exec(line);
    if (desc) {
      const value = desc[1]?.trim();
      if (value) description = description ? `${description} ${value}` : value;
      continue;
    }

    const output = /^adi-output:\s*(.+)$/i.exec(line);
    if (output) {
      const value = output[1]?.trim();
      if (value) outputs.push(value);
      continue;
    }

    const effect = /^adi-effect:\s*(.+)$/i.exec(line);
    if (effect) {
      const value = effect[1]?.trim();
      if (value) effects.push(value);
      continue;
    }

    const param = /^adi-param:\s*([a-z][a-z0-9_]*)\s*(?:\(([^)]*)\))?\s*(?:-\s*(.*))?$/i.exec(line);
    if (param) {
      const name = param[1];
      if (!name) continue;
      const flags = (param[2] ?? '').toLowerCase();
      params.push({
        name,
        description: (param[3] ?? '').trim() || name,
        type: flags.includes('number') ? 'number' : flags.includes('boolean') ? 'boolean' : 'string',
        required: !flags.includes('optional'),
      });
    }
  }

  const safeParams = params.slice(0, MAX_CUSTOM_PARAMS).map((param) => ({
    ...param,
    description: safeClipped(param.description, 2_000).trim() || param.name,
  }));
  let sideEffectManifest: SideEffectManifest | undefined;
  try {
    sideEffectManifest = normaliseSideEffectManifest({ outputs, effects });
  } catch {
    // Malformed annotations must not make a user-owned script disappear, but
    // they also must not cross into the callable tool as unbounded metadata.
  }

  return {
    description: safeClipped(description || `Script ${fallbackName} from your tools/scripts folder.`, 2_000).trim(),
    params: safeParams,
    ...(sideEffectManifest ? { sideEffectManifest } : {}),
  };
}

export function listFolderTools(): CustomTool[] {
  const dir = scriptsDir();
  let files: string[];
  try {
    files = boundedDirectoryNames(dir, MAX_CUSTOM_TOOLS);
  } catch {
    return [];
  }

  const out: CustomTool[] = [];
  for (const file of files.slice(0, MAX_CUSTOM_TOOLS)) {
    const ext = extname(file).toLowerCase();
    const language = LANG_BY_EXT[ext];
    if (!language) continue;

    const name = file.slice(0, -ext.length).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!NAME_RE.test(name)) continue;

    const path = join(dir, file);
    let text = '';
    try {
      const bounded = readBoundedTextFileSync(path, MAX_CUSTOM_SCRIPT_BYTES);
      if (bounded.truncated) continue;
      text = bounded.text;
    } catch {
      continue;
    }
    const { description, params, sideEffectManifest } = parseFolderScriptHeader(text, file);
    out.push({
      name,
      description: description.slice(0, 2_000),
      kind: 'script',
      language,
      params: params.slice(0, MAX_CUSTOM_PARAMS),
      script: text,
      sideEffectManifest,
      createdAt: '',
      source: 'folder',
      path,
    });
    if (out.length >= MAX_CUSTOM_TOOLS) break;
  }
  return out;
}

/* --------------------------------------------------------- stored tools */

const STORED_PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,80}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type WorkflowValueResult = { ok: true; value: unknown } | { ok: false };

interface WorkflowValueState {
  nodes: number;
  chars: number;
}

function normaliseWorkflowValue(
  value: unknown,
  depth = 0,
  state: WorkflowValueState = { nodes: 0, chars: 0 },
): WorkflowValueResult {
  if (depth > MAX_CUSTOM_WORKFLOW_DEPTH || ++state.nodes > MAX_CUSTOM_WORKFLOW_NODES) return { ok: false };
  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value === 'string') {
    state.chars += value.length;
    return value.length <= MAX_CUSTOM_WORKFLOW_ARGUMENT_CHARS && state.chars <= MAX_CUSTOM_WORKFLOW_ARGUMENT_CHARS
      ? { ok: true, value }
      : { ok: false };
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CUSTOM_WORKFLOW_COLLECTION_ITEMS) return { ok: false };
    const out: unknown[] = [];
    for (const item of value) {
      const result = normaliseWorkflowValue(item, depth + 1, state);
      if (!result.ok) return result;
      out.push(result.value);
    }
    return { ok: true, value: out };
  }
  if (!isPlainRecord(value)) return { ok: false };
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > MAX_CUSTOM_WORKFLOW_COLLECTION_ITEMS) return { ok: false };
    const item = value[key];
    if (!key || key.length > 200 || /[\r\n\0]/.test(key)) return { ok: false };
    const result = normaliseWorkflowValue(item, depth + 1, state);
    if (!result.ok) return result;
    out[key] = result.value;
  }
  return { ok: true, value: out };
}

function normaliseStoredParam(value: unknown): ToolParam | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.name !== 'string' || !STORED_PARAM_NAME_RE.test(value.name)) return null;
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2_000) return null;
  const type = value.type === undefined ? undefined : ['string', 'number', 'boolean'].includes(String(value.type)) ? value.type as ToolParam['type'] : null;
  if (type === null) return null;
  const required = value.required === undefined ? undefined : typeof value.required === 'boolean' ? value.required : null;
  if (required === null) return null;
  let defaultValue: string | number | boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'default')) {
    if (typeof value.default === 'string' && value.default.length <= MAX_CUSTOM_HTTP_BODY) defaultValue = value.default;
    else if (typeof value.default === 'number' && Number.isFinite(value.default)) defaultValue = value.default;
    else if (typeof value.default === 'boolean') defaultValue = value.default;
    else return null;
  }
  let choices: string[] | undefined;
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices) || value.choices.length > MAX_CUSTOM_CHOICES) return null;
    if (!value.choices.every((choice) => typeof choice === 'string' && choice.length <= 500)) return null;
    choices = value.choices.slice();
  }
  return {
    name: value.name,
    description: value.description.slice(0, 2_000),
    ...(type ? { type } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'default') ? { default: defaultValue } : {}),
    ...(choices ? { choices } : {}),
  };
}

export function normaliseStoredTool(value: unknown): CustomTool | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.name !== 'string' || !NAME_RE.test(value.name)) return null;
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2_000) return null;
  if (!Array.isArray(value.params) || value.params.length > MAX_CUSTOM_PARAMS) return null;
  const params = value.params.map(normaliseStoredParam);
  if (params.some((param): param is null => param === null)) return null;
  const kind = value.kind === undefined ? 'script' : value.kind;
  if (!['script', 'http', 'workflow'].includes(String(kind))) return null;
  const language = value.language === undefined ? 'powershell' : value.language;
  if (!['powershell', 'python', 'node'].includes(String(language))) return null;
  const script = value.script === undefined ? undefined : typeof value.script === 'string' ? value.script : null;
  if (script === null || (script !== undefined && script.length > MAX_CUSTOM_SCRIPT_BYTES)) return null;
  if (kind === 'script' && !script?.trim()) return null;
  const method = value.method === undefined ? undefined : typeof value.method === 'string' && value.method.length <= 100 && !/[\r\n\0]/.test(value.method) ? value.method : null;
  if (method === null) return null;
  const url = value.url === undefined ? undefined : typeof value.url === 'string' && value.url.length <= 8_000 && !/[\r\n\0]/.test(value.url) ? value.url : null;
  if (url === null || (kind === 'http' && !url?.trim())) return null;
  const body = value.body === undefined ? undefined : typeof value.body === 'string' && value.body.length <= MAX_CUSTOM_HTTP_BODY ? value.body : null;
  if (body === null) return null;
  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    if (!isPlainRecord(value.headers) || Object.keys(value.headers).length > 40) return null;
    const entries = Object.entries(value.headers);
    if (!entries.every(([key, header]) => key.length <= 200 && typeof header === 'string' && header.length <= 4_000 && !/[\r\n\0]/.test(header))) return null;
    headers = Object.fromEntries(entries) as Record<string, string>;
  }
  let steps: WorkflowStep[] | undefined;
  if (kind === 'workflow') {
    if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_CUSTOM_PARAMS) return null;
    const workflowState: WorkflowValueState = { nodes: 0, chars: 0 };
    const normalizedSteps = (value.steps as unknown[]).map((step): WorkflowStep | null => {
      if (!isPlainRecord(step) || typeof step.tool !== 'string' || !step.tool.trim() || step.tool.length > 200 || /[\r\n\0]/.test(step.tool) || !isPlainRecord(step.args)) return null;
      const normalizedArgs = normaliseWorkflowValue(step.args, 0, workflowState);
      if (!normalizedArgs.ok || !isPlainRecord(normalizedArgs.value)) return null;
      return { tool: step.tool, args: normalizedArgs.value };
    });
    if (normalizedSteps.some((step): step is null => step === null)) return null;
    steps = normalizedSteps as WorkflowStep[];
  }
  let sideEffectManifest: SideEffectManifest | undefined;
  try {
    sideEffectManifest = normaliseSideEffectManifest(value.sideEffectManifest);
  } catch {
    return null;
  }
  return {
    name: value.name,
    description: redactSecrets(value.description).trim().slice(0, 2_000),
    kind: kind as ToolKind,
    language: language as ToolLanguage,
    params: params as ToolParam[],
    ...(script !== undefined ? { script } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(steps ? { steps } : {}),
    ...(sideEffectManifest ? { sideEffectManifest } : {}),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 80) : '',
    source: 'agent',
  };
}

function readStored(): CustomTool[] {
  try {
    return boundedDirectoryNames(toolsDir(), MAX_CUSTOM_DISCOVERY_ENTRIES)
      .filter((f) => f.endsWith('.json'))
      .slice(0, MAX_CUSTOM_TOOLS)
      .map((f) => {
        try {
          const path = join(toolsDir(), f);
          const bounded = readBoundedTextFileSync(path, MAX_CUSTOM_DEFINITION_BYTES);
          if (bounded.truncated) return null;
          return normaliseStoredTool(JSON.parse(bounded.text));
        } catch {
          return null;
        }
      })
      .filter((t): t is CustomTool => !!t && NAME_RE.test(t.name));
  } catch {
    return [];
  }
}

function listInstalledSkillTools(): CustomTool[] {
  const out: CustomTool[] = [];
  for (const record of installedSkillTools()) {
    const normalized = normaliseStoredTool({
      ...record.tool,
      createdAt: '',
    });
    if (!normalized) continue;
    out.push({
      ...normalized,
      source: 'skill',
      path: record.manifestPath,
      skillId: record.packageId,
    });
    if (out.length >= MAX_CUSTOM_TOOLS) break;
  }
  return out;
}

/**
 * Everything callable that was not compiled in.
 *
 * A stored tool wins over a folder script of the same name: the stored one was
 * approved through the gate, and a file appearing in a folder should not be able
 * to quietly take over a name that already means something.
 */
export function listCustomTools(): CustomTool[] {
  const stored = readStored();
  const taken = new Set(stored.map((t) => t.name));
  const skillTools = listInstalledSkillTools().filter((tool) => {
    if (taken.has(tool.name)) return false;
    taken.add(tool.name);
    return true;
  });
  const folderTools = listFolderTools().filter((tool) => {
    if (taken.has(tool.name)) return false;
    taken.add(tool.name);
    return true;
  });
  return [...stored, ...skillTools, ...folderTools].slice(0, MAX_CUSTOM_TOOLS);
}

function studioParamFor(param: ToolParam): ToolStudioParam {
  return {
    name: safeClipped(param.name, 80),
    description: safeClipped(param.description, 2_000),
    ...(param.type ? { type: param.type } : {}),
    ...(param.required !== undefined ? { required: param.required } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
    ...(param.choices?.length ? { choices: param.choices.slice(0, MAX_CUSTOM_CHOICES).map((choice) => safeClipped(choice, 500)) } : {}),
  };
}

function studioManifestFor(manifest: SideEffectManifest | undefined): ToolStudioSideEffectManifest | undefined {
  if (!manifest) return undefined;
  const outputs = manifest.outputs?.slice(0, MAX_CUSTOM_MANIFEST_OUTPUTS).map((value) => safeClipped(value, MAX_CUSTOM_MANIFEST_OUTPUT_CHARS));
  const effects = manifest.effects?.slice(0, MAX_CUSTOM_MANIFEST_EFFECTS).map((value) => safeClipped(value, MAX_CUSTOM_MANIFEST_EFFECT_CHARS));
  const reason = manifest.reason ? safeClipped(manifest.reason, MAX_CUSTOM_MANIFEST_EFFECT_CHARS) : undefined;
  if (!outputs?.length && !effects?.length && !reason) return undefined;
  return {
    ...(outputs?.length ? { outputs } : {}),
    ...(effects?.length ? { effects } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Metadata for the Tool Studio library; large executable bodies stay out of list responses. */
export function toolStudioSummaryFor(tool: CustomTool): ToolStudioSummary {
  const kind = tool.kind ?? 'script';
  return {
    name: safeClipped(tool.name, 80),
    description: safeClipped(tool.description, 2_000),
    kind,
    language: tool.language ?? 'powershell',
    params: (tool.params ?? []).slice(0, MAX_CUSTOM_PARAMS).map(studioParamFor),
    source: tool.source ?? 'agent',
    createdAt: safeClipped(tool.createdAt, 80),
    ...(tool.path ? { path: safeClipped(tool.path, 2_000) } : {}),
    ...(tool.skillId ? { skillId: safeClipped(tool.skillId, 200) } : {}),
    ...(kind === 'http' && tool.method ? { method: safeClipped(tool.method, 100) } : {}),
    ...(kind === 'http' && tool.url ? { url: safeClipped(tool.url, 8_000) } : {}),
    ...(kind === 'workflow' ? { stepTools: (tool.steps ?? []).slice(0, MAX_CUSTOM_PARAMS).map((step) => safeClipped(step.tool, 200)) } : {}),
    ...(tool.script !== undefined ? { scriptChars: tool.script.length } : {}),
    ...(tool.body !== undefined ? { bodyChars: tool.body.length } : {}),
    ...(tool.headers ? { headerCount: Object.keys(tool.headers).length } : {}),
  };
}

/** Full definition for one selected tool. This is never used for the model catalog. */
export function toolStudioDefinitionFor(tool: CustomTool): ToolStudioDefinition {
  const kind = tool.kind ?? 'script';
  const steps: ToolStudioWorkflowStep[] | undefined = tool.steps?.map((step) => ({
    tool: step.tool,
    args: { ...step.args },
  }));
  const sideEffectManifest = studioManifestFor(tool.sideEffectManifest);
  return {
    name: tool.name,
    description: tool.description,
    kind,
    language: tool.language ?? 'powershell',
    params: (tool.params ?? []).map((param) => studioParamFor(param)),
    ...(tool.script !== undefined ? { script: tool.script } : {}),
    ...(tool.method !== undefined ? { method: tool.method } : {}),
    ...(tool.url !== undefined ? { url: tool.url } : {}),
    ...(tool.headers ? { headers: { ...tool.headers } } : {}),
    ...(tool.body !== undefined ? { body: tool.body } : {}),
    ...(steps ? { steps } : {}),
    ...(sideEffectManifest ? { sideEffectManifest } : {}),
    source: tool.source ?? 'agent',
    createdAt: tool.createdAt,
    ...(tool.path ? { path: tool.path } : {}),
    ...(tool.skillId ? { skillId: tool.skillId } : {}),
  };
}

/** Renderer-facing library listing with no executable bodies in the collection response. */
export function listToolStudioTools(): ToolStudioSummary[] {
  return listCustomTools().map(toolStudioSummaryFor);
}
export interface WorkflowSummary {
  name: string;
  description: string;
  steps: string[];
  createdAt: string;
}

/** Returns stored workflow metadata without loading scripts or exposing step arguments. */
export function workflowSummaryFor(tool: CustomTool): WorkflowSummary {
  const steps = Array.isArray(tool.steps)
    ? tool.steps.slice(0, MAX_CUSTOM_PARAMS).flatMap((step) => {
        if (!step || typeof step !== 'object' || typeof step.tool !== 'string') return [];
        return [safeClipped(step.tool, 80)];
      })
    : [];
  return {
    name: safeClipped(tool.name, 80),
    description: safeClipped(tool.description, 2_000),
    steps,
    createdAt: safeClipped(tool.createdAt, 80),
  };
}

/** Search-facing workflow catalog; no script bodies or workflow arguments cross this boundary. */
export function listWorkflowSummaries(): WorkflowSummary[] {
  return listCustomTools()
    .filter((tool) => tool.kind === 'workflow')
    .slice(0, MAX_CUSTOM_TOOLS)
    .map(workflowSummaryFor);
}

export function findCustomTool(name: string): CustomTool | undefined {
  return listCustomTools().find((t) => t.name === name);
}

/** JSON Schema for one dynamic tool, so the model sees it like any built-in. */
export function schemaFor(tool: CustomTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const params = (tool.params ?? []).slice(0, MAX_CUSTOM_PARAMS);
  for (const p of params) {
    const description = safeClipped(p.description, 1_000);
    const prop: Record<string, unknown> = {
      type: p.type ?? 'string',
      description,
    };
    if (p.choices?.length) prop.enum = p.choices.slice(0, MAX_CUSTOM_CHOICES).map((choice) => safeClipped(choice, 500));
    if (p.default !== undefined) prop.description = `${description} (default: ${safeClipped(p.default, 500)})`;
    properties[clipped(p.name, 80)] = prop;
  }
  return {
    type: 'object',
    properties,
    required: params.filter((p) => p.required !== false && p.default === undefined).map((p) => clipped(p.name, 80)),
  };
}

export function describeCustomTool(tool: CustomTool): string {
  const where =
    tool.source === 'folder'
      ? 'from ' + safeClipped(tool.path, 2_000)
      : tool.source === 'skill'
        ? 'from installed skill ' + safeClipped(tool.skillId ?? 'unknown', 100)
        : 'created ' + ((tool.createdAt || '').slice(0, 10) || 'earlier');
  const kind = tool.kind ?? 'script';
  const detail =
    kind === 'http'
      ? `${safeClipped(tool.method ?? 'GET', 20)} ${safeClipped(tool.url ?? '', 2_000)}`
      : kind === 'workflow'
        ? `${Math.min(MAX_CUSTOM_PARAMS, (tool.steps ?? []).length)} step(s): ${(tool.steps ?? []).slice(0, MAX_CUSTOM_PARAMS).map((s) => clipped(s.tool, 80)).join(' -> ')}`
        : `${tool.language ?? 'powershell'} script`;
  const manifestOutputs = Array.isArray(tool.sideEffectManifest?.outputs) ? tool.sideEffectManifest.outputs.length : 0;
  const manifestEffects = Array.isArray(tool.sideEffectManifest?.effects) ? tool.sideEffectManifest.effects.length : 0;
  const manifestParts: string[] = [];
  if (manifestOutputs) manifestParts.push(manifestOutputs + ' output path(s)');
  if (manifestEffects) manifestParts.push(manifestEffects + ' external effect(s)');
  const manifestNote = manifestParts.length ? '; declares ' + manifestParts.join(' and ') : '';
  return safeClipped(tool.description + ' (' + kind + ' tool you can run, ' + detail + manifestNote + ', ' + where + ')', 4_000);
}

/* ------------------------------------------------------------- validation */

/** Checks and coerces arguments before anything runs. */
export function resolveArgs(tool: CustomTool, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of (tool.params ?? []).slice(0, MAX_CUSTOM_PARAMS)) {
    let value = args[p.name];
    if (value === undefined || value === '') {
      if (p.default !== undefined) value = p.default;
      else if (p.required === false) value = '';
      else throw new Error(`"${clipped(p.name, 80)}" is required. ${clipped(p.description, 300)}`);
    }

    if (p.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`"${clipped(p.name, 80)}" must be a number, got "${clipped(value, 300)}".`);
      value = n;
    } else if (p.type === 'boolean') {
      value = value === true || value === 'true' || value === 1 || value === '1';
    } else {
      const text = String(value);
      if (text.length > MAX_CUSTOM_HTTP_BODY) throw new Error(`"${clipped(p.name, 80)}" exceeded the ${MAX_CUSTOM_HTTP_BODY}-character safety limit.`);
      value = text;
    }

    if (p.choices?.length && !p.choices.slice(0, MAX_CUSTOM_CHOICES).includes(String(value))) {
      throw new Error(`"${clipped(p.name, 80)}" must be one of: ${p.choices.slice(0, MAX_CUSTOM_CHOICES).map((choice) => clipped(choice, 300)).join(', ')}.`);
    }
    out[p.name] = value;
  }
  return out;
}

/* ------------------------------------------------------------- rendering */

/**
 * Substitutes {{param}} placeholders, by two different strategies.
 *
 * The obvious approach — replace the placeholder with a quoted literal — is
 * safe only where the placeholder stands alone. Authors naturally write
 * `"Hello {{who}}"`, and a single-quoted literal dropped inside a *double*
 * quoted PowerShell string is not inert at all: PowerShell expands `$(...)`
 * and `$var` there, so a parameter value of `$(Write-Output x)` executes. That
 * is a real hole, because the user approves the script once and the values flow
 * in afterwards — often from a web page or a file.
 *
 * So PowerShell binds its parameters to variables instead and references those.
 * A variable interpolates to its contents inside double quotes and PowerShell
 * does not then re-expand those contents, which is exactly the property needed.
 *
 * Python and Node get literals, because neither interpolates a bare identifier
 * inside a string. There, a placeholder used inside a string produces a syntax
 * error — a loud, immediate failure, which is the safe way to be wrong. Binding
 * variables for them would instead print the literal text `__adi_who`, which is
 * silently wrong, and silence is worse.
 */
function literalFor(language: ToolLanguage, value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') {
    if (language === 'powershell') return value ? '$true' : '$false';
    if (language === 'python') return value ? 'True' : 'False';
    return value ? 'true' : 'false';
  }
  const text = String(value);
  if (language === 'powershell') return `'${text.replace(/'/g, "''")}'`;
  // JSON string syntax is valid in both Python and JavaScript.
  return JSON.stringify(text);
}

/** Matches {{name}}, and the same already wrapped in quotes by the author. */
function placeholderRe(param: string): RegExp {
  const name = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A placeholder the author quoted is matched with its quotes, since adding
  // another pair produced ''C'' — a syntax error rather than a string.
  return new RegExp(`(['"])\\{\\{${name}\\}\\}\\1|\\{\\{${name}\\}\\}`, 'g');
}

export function renderScript(tool: CustomTool, args: Record<string, unknown>): string {
  const language = tool.language ?? 'powershell';
  const params = (tool.params ?? []).slice(0, MAX_CUSTOM_PARAMS);
  let script = requireScriptSize(tool.script ?? '');

  if (language === 'powershell') {
    const bindings: string[] = [];
    for (const p of params) {
      const variable = `$__adi_${p.name}`;
      bindings.push(`${variable} = ${literalFor('powershell', args[p.name] ?? '')}`);
      script = script.replace(placeholderRe(p.name), variable);
    }
    return requireScriptSize(bindings.length ? `${bindings.join('\n')}\n\n${script}` : script);
  }

  for (const p of params) {
    script = script.replace(placeholderRe(p.name), literalFor(language, args[p.name] ?? ''));
    requireScriptSize(script);
  }
  return requireScriptSize(script);
}

/** Fills {{param}} into a URL, a header or a body, escaping per position. */
function fillTemplate(text: string, args: Record<string, unknown>, urlEncode: boolean): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = String(args[key] ?? '');
    return urlEncode ? encodeURIComponent(value) : value;
  });
}

export interface RenderedHttp {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function renderHttp(tool: CustomTool, args: Record<string, unknown>): RenderedHttp {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tool.headers ?? {}).slice(0, 40)) {
    const name = clipped(k, 200);
    const value = fillTemplate(v, args, false);
    if (!name || value.length > 4_000 || /[\r\n]/.test(value)) throw new Error('Custom HTTP header is invalid or too long.');
    headers[name] = value;
  }
  const method = (tool.method ?? 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error('Custom HTTP method is invalid.');
  const url = fillTemplate(tool.url ?? '', args, true);
  if (url.length > 8_000) throw new Error('Custom HTTP URL exceeded the safety limit.');
  const body = tool.body ? fillTemplate(tool.body, args, false) : undefined;
  if (body && body.length > MAX_CUSTOM_HTTP_BODY) throw new Error('Custom HTTP body exceeded the safety limit.');
  return { method, url, headers, body };
}

/**
 * Resolves a workflow's steps against its arguments.
 *
 * Steps can also refer to what an earlier step returned, as {{step1}}, which is
 * what makes this composition rather than a list.
 */
export function renderWorkflow(
  tool: CustomTool,
  args: Record<string, unknown>,
  outputs: string[] = [],
): WorkflowStep[] {
  const state: WorkflowValueState = { nodes: 0, chars: 0 };
  const fill = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_CUSTOM_WORKFLOW_DEPTH || ++state.nodes > MAX_CUSTOM_WORKFLOW_NODES) {
      throw new Error('Workflow arguments are nested or large beyond the safety limit.');
    }
    if (typeof value === 'string') {
      const rendered = value.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
        const step = /^step(\d+)$/.exec(key);
        if (step) return outputs[Number(step[1]) - 1] ?? '';
        return String(args[key] ?? '');
      });
      state.chars += rendered.length;
      if (rendered.length > MAX_CUSTOM_WORKFLOW_ARGUMENT_CHARS || state.chars > MAX_CUSTOM_WORKFLOW_ARGUMENT_CHARS) {
        throw new Error('Workflow arguments expanded beyond the safety limit.');
      }
      return rendered;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_CUSTOM_WORKFLOW_COLLECTION_ITEMS) throw new Error('Workflow arguments contain too many list items.');
      return value.map((item) => fill(item, depth + 1));
    }
    if (isPlainRecord(value)) {
      const output: Record<string, unknown> = {};
      let count = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        count += 1;
        if (count > MAX_CUSTOM_WORKFLOW_COLLECTION_ITEMS) throw new Error('Workflow arguments contain too many fields.');
        if (!key || key.length > 200 || /[\r\n\0]/.test(key)) throw new Error('Workflow arguments contain an invalid field name.');
        output[key] = fill(value[key], depth + 1);
      }
      return output;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new Error('Workflow arguments contain an unsupported value.');
  };

  return (tool.steps ?? []).map((s) => {
    const rendered = fill(s.args ?? {});
    if (!isPlainRecord(rendered)) throw new Error('Workflow step arguments must be an object.');
    return { tool: s.tool, args: rendered };
  });
}

/* ---------------------------------------------------------------- saving */

const RESERVED = new Set(['create_tool', 'update_tool', 'delete_tool', 'list_tools']);

export function saveCustomTool(tool: Omit<CustomTool, 'createdAt'>): string {
  if (!NAME_RE.test(tool.name)) {
    throw new Error('Tool names must be lowercase letters, digits and underscores (3-40 chars).');
  }
  if (RESERVED.has(tool.name)) throw new Error(`"${tool.name}" is a built-in name.`);
  const description = clipped(tool.description, 2_000).trim();
  if (!description) throw new Error('A custom tool needs a description.');
  const params = Array.isArray(tool.params) ? tool.params : [];
  const sideEffectManifest = normaliseSideEffectManifest(tool.sideEffectManifest);
  if (params.length > MAX_CUSTOM_PARAMS) throw new Error(`A custom tool may define at most ${MAX_CUSTOM_PARAMS} parameters.`);

  const kind = tool.kind ?? 'script';
  if (kind === 'script' && !tool.script?.trim()) throw new Error('A script tool needs a script.');
  if (kind === 'script' && (tool.script?.length ?? 0) > MAX_CUSTOM_SCRIPT_BYTES) throw new Error(`A custom script may not exceed ${MAX_CUSTOM_SCRIPT_BYTES} characters.`);
  if (kind === 'http' && !tool.url?.trim()) throw new Error('An API tool needs a url.');
  if (kind === 'http' && (tool.body?.length ?? 0) > MAX_CUSTOM_HTTP_BODY) throw new Error(`An API body may not exceed ${MAX_CUSTOM_HTTP_BODY} characters.`);
  if (kind === 'workflow' && !tool.steps?.length) throw new Error('A workflow needs at least one step.');
  if (kind === 'workflow' && (tool.steps?.length ?? 0) > MAX_CUSTOM_PARAMS) throw new Error(`A workflow may contain at most ${MAX_CUSTOM_PARAMS} steps.`);

  const record: CustomTool = {
    ...tool,
    description,
    kind,
    language: kind === 'script' ? inferToolLanguage(tool.script ?? '', tool.language) : tool.language,
    params,
    sideEffectManifest,
    createdAt: new Date().toISOString(),
    source: 'agent',
  };
  const safeRecord = normaliseStoredTool(record);
  if (!safeRecord) throw new Error('Custom tool definition failed schema validation.');
  const path = join(toolsDir(), `${tool.name}.json`);
  const serialized = stringifyJsonWithinLimit(
    safeRecord,
    MAX_CUSTOM_DEFINITION_BYTES - 1,
    'Custom tool definition (' + MAX_CUSTOM_DEFINITION_BYTES.toLocaleString() + '-byte safety limit)',
    2,
  );
  writeTextFileAtomic(path, serialized);
  const verified = readBoundedTextFileSync(path, MAX_CUSTOM_DEFINITION_BYTES);
  if (verified.truncated || verified.text !== serialized) {
    throw new Error(`Custom tool persistence could not be verified: ${path}`);
  }
  notifyToolUpdates();
  return `Saved ${kind} tool "${tool.name}". It is callable from now on, no restart needed.`;
}

export function updateCustomTool(name: string, patch: Partial<CustomTool>): string {
  const existing = findCustomTool(name);
  if (!existing) throw new Error(`No tool named ${name}.`);
  if (existing.source === 'folder') {
    throw new Error(
      `${name} is a file at ${existing.path}. Edit the file with edit_file; it is re-read on every call.`,
    );
  }
  if (existing.source === 'skill') {
    throw new Error(
      name + ' belongs to installed skill ' + existing.skillId + '. Update or remove that skill instead.',
    );
  }
  return saveCustomTool(mergeCustomToolPatch(existing, patch, name));
}

export function mergeCustomToolPatch(
  existing: CustomTool,
  patch: Partial<CustomTool>,
  name = existing.name,
): Omit<CustomTool, 'createdAt'> {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<CustomTool>;
  const { createdAt: _createdAt, ...merged } = { ...existing, ...definedPatch, name };
  return merged;
}

export function deleteCustomTool(name: string): string {
  const existing = findCustomTool(name);
  if (existing?.source === 'folder') {
    throw new Error(`${name} is your own file at ${existing.path}. Delete the file if you want it gone.`);
  }
  if (existing?.source === 'skill') {
    throw new Error(name + ' belongs to installed skill ' + existing.skillId + '. Disable or remove that skill instead.');
  }
  const path = join(toolsDir(), `${name}.json`);
  if (!existsSync(path)) throw new Error(`No tool named ${name}.`);
  unlinkSync(path);
  if (existsSync(path)) throw new Error(`Custom tool deletion could not be verified: ${path}`);
  notifyToolUpdates();
  return `Deleted tool "${name}".`;
}

/* --------------------------------------------------------------- running */

/** Runs a script tool in whichever language it was written in. */
export async function runScriptTool(tool: CustomTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const rendered = renderScript(tool, args);
  switch (tool.language ?? 'powershell') {
    case 'python':
      return runPythonStrict(rendered, undefined, signal);
    case 'node':
      return runNodeStrict(rendered, undefined, signal);
    default:
      return runPowerShellStrict(rendered, undefined, signal);
  }
}

export async function runHttpTool(tool: CustomTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const req = renderHttp(tool, args);
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    throw new Error('Custom HTTP URL must be valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Custom HTTP URL must use HTTP or HTTPS.');
  const timeout = AbortSignal.timeout(30_000);
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(parsed, {
      method: req.method,
      headers: { 'User-Agent': 'AdiPet/0.1', ...req.headers },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      signal: activeSignal,
    });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  if (
    typeof res.ok !== 'boolean' ||
    typeof res.status !== 'number' ||
    !Number.isFinite(res.status) ||
    typeof res.statusText !== 'string'
  ) {
    await cancelHttpResponseBody(res);
    throw new Error('Custom HTTP response was malformed.');
  }
  let bounded: { text: string; truncated: boolean };
  try {
    bounded = await readBoundedHttpResponse(res, activeSignal);
  } catch (error) {
    throwIfAborted(signal);
    if (activeSignal.aborted) throw new Error('Custom HTTP request timed out.');
    throw error;
  }
  if (activeSignal.aborted) {
    throwIfAborted(signal);
    throw new Error('Custom HTTP request timed out.');
  }
  throwIfAborted(signal);
  const shown = bounded.text.length > MAX_CUSTOM_OUTPUT
    ? `${bounded.text.slice(0, MAX_CUSTOM_OUTPUT)}\n…[truncated]`
    : bounded.text;
  const marker = bounded.truncated ? '\n…[response body bounded]' : '';
  const output = boundedOutput(`${res.status} ${res.statusText}\n\n${shown}${marker}`, MAX_CUSTOM_OUTPUT + 2_000, '[custom HTTP output truncated]');
  if (!res.ok) throw new Error(output);
  return output;
}

/* ------------------------------------------------------------- built-ins */

const BUILTIN_MANIFEST_FORMAT_VERSION = '4';
const BUILTIN_MANIFEST_STAMP = '.manifest-version';

function builtinManifestVersion(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): string {
  const hash = createHash('sha256');
  hash.update(BUILTIN_MANIFEST_FORMAT_VERSION);
  for (const tool of tools) {
    hash.update('\0');
    hash.update(tool.name);
    hash.update('\0');
    hash.update(tool.description);
    hash.update('\0');
    hash.update(JSON.stringify(tool.parameters));
  }
  return hash.digest('hex');
}

function builtinManifestsAreCurrent(
  dir: string,
  tools: readonly { name: string }[],
  version: string,
): boolean {
  try {
    const stamp = readBoundedTextFileSync(join(dir, BUILTIN_MANIFEST_STAMP), 128);
    if (stamp.truncated || stamp.text.trim() !== version) return false;
    const expected = new Set(tools.map((tool) => `${tool.name}.json`));
    const manifests = boundedDirectoryNames(dir, MAX_CUSTOM_DISCOVERY_ENTRIES)
      .filter((name) => name.endsWith('.json'));
    return manifests.length === expected.size && manifests.every((name) => expected.has(name));
  } catch {
    return false;
  }
}

/**
 * Writes a manifest of every built-in tool into the tools folder.
 *
 * These are reference copies: readable, diffable, and a template to copy when
 * writing a new one. They refresh when the built-in catalog or reference format
 * changes and carry a `builtin`
 * flag, so editing one has no effect — the real definitions live in code, and
 * pretending otherwise would be worse than not writing them at all.
 */
export function writeBuiltinManifests(
  tools: { name: string; description: string; parameters: unknown }[],
): void {
  const dir = join(toolsDir(), 'builtin');
  mkdirSync(dir, { recursive: true });
  scriptsDir(); // Create the folder without adding sample tools.
  const readmePath = join(toolsDir(), 'README.md');
  const manifestVersion = builtinManifestVersion(tools);
  if (
    existsSync(readmePath) &&
    builtinManifestsAreCurrent(dir, tools, manifestVersion)
  ) {
    return;
  }

  let allArtifactsWritten = true;

  for (const t of tools) {
    const record = {
      name: t.name,
      builtin: true,
      note: 'Reference only. Built-in tools are defined in code; editing this file does nothing.',
      description: t.description,
      parameters: t.parameters,
    };
    try {
      writeTextFileAtomic(join(dir, `${t.name}.json`), JSON.stringify(record, null, 2));
    } catch {
      allArtifactsWritten = false;
      /* not worth failing startup over */
    }
  }

  if (allArtifactsWritten) {
    try {
      const current = new Set(tools.map((t) => `${t.name}.json`));
      for (const f of boundedDirectoryNames(dir, MAX_CUSTOM_DISCOVERY_ENTRIES)) {
        if (f.endsWith('.json') && !current.has(f)) unlinkSync(join(dir, f));
      }
    } catch {
      allArtifactsWritten = false;
      /* Keep older reference files if the directory cannot be enumerated. */
    }
  }

  const index = [
    '# Adi tools',
    '',
    'Built-in tools are listed in `builtin/` for reference — they are defined in',
    'code and those files refresh when the catalog or reference format changes.',
    '',
    'The .json files in this folder are tools Adi wrote for itself. Those are',
    'real: editing one changes what runs.',
    '',
    '## Adding your own',
    '',
    'Drop a `.ps1`, `.py` or `.js` file into `scripts/` and it becomes a tool Adi',
    'can call, with no restart. Describe it with header comments:',
    '',
    '```',
    '# adi: What this tool does',
    '# adi-param: folder - which folder to work in',
    '# adi-param: count (number, optional) - how many',
    '```',
    '',
    'Reference the parameters in the script as {{folder}} and {{count}}. They are',
    'substituted as quoted literals of the language, so a value can change what',
    'the script works on but never what it does.',
    '',
    `## Built-in (${tools.length})`,
    '',
    ...tools.map((t) => `- **${t.name}** — ${t.description.split('.')[0]}.`),
  ].join('\n');
  try {
    writeTextFileAtomic(readmePath, index);
  } catch {
    allArtifactsWritten = false;
    /* ditto */
  }
  if (allArtifactsWritten) {
    try {
      writeTextFileAtomic(join(dir, BUILTIN_MANIFEST_STAMP), manifestVersion + '\n');
    } catch {
      /* A missing stamp only makes the next startup repair the references again. */
    }
  }
}

/* ------------------------------------------------------------- lessons */

function lessonsPath(): string {
  return join(app.getPath('userData'), 'lessons.md');
}

/**
 * Notes the agent keeps for itself about what went wrong and what worked.
 * Loaded into the system prompt so mistakes are not repeated next session.
 */
export function readLessons(): string {
  return listLessonsFile(lessonsPath());
}

export function listLessonEntries(): LessonListView {
  return listLessonEntriesFile(lessonsPath());
}

export function lessonsForPrompt(query: string): string {
  return lessonsForPromptFromFile(lessonsPath(), query);
}

export function appendLesson(lesson: string): string {
  const result = appendLessonFile(lessonsPath(), lesson);
  if (result.alreadyPresent) return 'Already noted; nothing added.';
  return result.redacted
    ? `Noted. Secret-like values were redacted before saving. (${lessonsPath()})`
    : `Noted. (${lessonsPath()})`;
}
export function editLesson(index: number, lesson: string): string {
  const result = editLessonFile(lessonsPath(), index, lesson);
  if (result.alreadyPresent) return 'Already noted; nothing changed.';
  if (result.redacted) return 'Updated lesson ' + index + '; secret-like values were redacted.';
  return 'Updated lesson ' + index + '.';
}

export function deleteLesson(index: number): string {
  deleteLessonFile(lessonsPath(), index);
  return 'Deleted lesson ' + index + '.';
}
