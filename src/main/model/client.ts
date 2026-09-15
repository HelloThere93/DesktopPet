import { randomUUID } from 'node:crypto';
import { throwIfAborted, waitWithAbort } from '../abort';
import { normaliseEffort } from '../../shared/types';
import { redactSecrets } from '../redaction';
import type { ChatMessage, ProviderId, ProviderInfo, ToolCall } from '../../shared/types';
import { forceRefresh, getValidTokens } from '../auth/oauth';
import { logModelRequestMetric, type ModelRequestSelectionMode } from '../observability';
import type { OperationId } from '../operations';
import { toolSchemaSelectionForNames } from '../tools/registry';
import { streamAnthropic, streamChatCompletions } from './adapters';
import { makeToolPayloadMetrics, toolPayloadForShape, jsonByteLength } from './tool-payload';
import { activeProvider, baseUrlFor, loadApiKey } from './providers';
import { normaliseImageDataUrl } from '../attachments';
import { MAX_MODEL_NAME_CHARS, MAX_MODEL_TEXT_CHARS, MAX_MODEL_TOOL_ARGUMENT_CHARS, MAX_MODEL_TOOL_CALLS, decodeModelStreamChunk, streamBuffer, streamIdentifier, streamText } from './stream-limits';
import { MAX_CUSTOM_MODELS, normaliseModelId, normaliseRemoteModelIds } from './catalog';
import { cancelResponseBody, parseJsonRecord, readBoundedJson, readBoundedResponseText } from './response-bounds';
import { stringifyJsonWithinLimit } from '../bounded-json';
import { assertModelRequestWithinLimit, MAX_MODEL_REQUEST_BYTES } from './request-bounds';


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const MAX_MODEL_PROBE_DETAIL_CHARS = 20_000;

export function normaliseModelProbeDetail(value: unknown, fallback = 'Unknown provider error.'): string {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : fallback;
  return redactSecrets(text).slice(0, MAX_MODEL_PROBE_DETAIL_CHARS);
}
/**
 * Talks to the Responses API using the user's ChatGPT-subscription token.
 *
 * Subscription tokens are accepted by the ChatGPT backend rather than the
 * platform API host, so the base URL differs from api.openai.com. That surface
 * is not formally documented, so the endpoint stays overridable and
 * `probeEndpoint` confirms which host actually answers before we rely on it.
 */
const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const PLATFORM_BASE = 'https://api.openai.com/v1';
const RESOLVED_BASE_INVALIDATION_STATUSES = new Set([404, 405, 408, 502, 503, 504]);

export function shouldInvalidateResolvedBase(status: number): boolean {
  return RESOLVED_BASE_INVALIDATION_STATUSES.has(status);
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onDone: () => void;
}

interface ResponsesInput {
  role: string;
  content: { type: string; text: string }[];
}

/** Map our stored messages onto Responses API input items. */
function toInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content,
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content.trim()) {
        items.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        } satisfies ResponsesInput);
      }
      for (const c of m.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: stringifyJsonWithinLimit(c.args, 200_000, 'Model tool arguments'),
        });
      }
      continue;
    }
    const parts: { type: string; text?: string; image_url?: string }[] = [
      { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content },
    ];
    // Screenshots ride along as real visual input; a file path would tell the
    // model nothing about what is actually on the screen.
    const imageDataUrl = normaliseImageDataUrl(m.imageDataUrl);
    if (imageDataUrl && m.role !== 'assistant') {
      parts.push({ type: 'input_image', image_url: imageDataUrl });
    }
    items.push({ role: m.role, content: parts });
  }
  return items;
}

function toolDefs(schemas: readonly { name: string; description: string; parameters: Record<string, unknown> }[]): unknown[] {
  return toolPayloadForShape('responses', schemas);
}

/**
 * Responses API headers for a platform API key.
 *
 * Deliberately without the Codex originator: that header exists to tell the
 * ChatGPT backend which client is calling on a subscription, and sending it to
 * api.openai.com with a paid key just muddies the request.
 */
function apiKeyHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

function headersFor(accessToken: string, accountId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    // The Codex backend gates model access on the originator. We authenticate
    // with Codex's public client_id against the same endpoint, so we identify
    // as that client; a custom value gets every model rejected as
    // "not supported when using Codex with a ChatGPT account".
    originator: 'codex_cli_rs',
    session_id: randomUUID(),
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

/**
 * Models selectable in the UI, best first.
 *
 * Availability depends on the plan and moves over time — the whole GPT-5.2 /
 * 5.3-codex generation is already deprecated for ChatGPT sign-in, and 5.4/5.5
 * retire on 2026-08-31 — so the probe checks these against the live account
 * rather than trusting the list.
 */
export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

export const KNOWN_MODELS: ModelOption[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Flagship — strongest at coding and computer use' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Balanced, good default for everyday work' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Fastest and cheapest' },
  { id: 'gpt-5.3-codex-spark', label: 'Codex Spark', note: 'Near-instant; ChatGPT Pro only' },
  { id: 'gpt-5.5', label: 'GPT-5.5', note: 'Previous generation — retires 2026-08-31' },
  { id: 'gpt-5.4', label: 'GPT-5.4', note: 'Previous generation — retires 2026-08-31' },
];

/**
 * Models learned at runtime, so a newly released id can be used without a code
 * change: anything the account accepts is remembered and offered next time.
 */
let discoveredModels: ModelOption[] = [];
// Live provider catalogues are session-scoped and kept separate from the
// user's persisted custom ids, so switching providers cannot leak stale names.
const remoteModelsByProvider = new Map<ProviderId, ModelOption[]>();

export function setDiscoveredModels(models: ModelOption[]): void {
  const seen = new Set<string>();
  discoveredModels = (Array.isArray(models) ? models : []).flatMap((model) => {
    const id = normaliseModelId(model?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = normaliseModelId(model?.label) ?? id;
    const note = typeof model?.note === 'string' ? model.note.slice(0, 2_000) : undefined;
    return [{ id, label, note }];
  }).slice(0, MAX_CUSTOM_MODELS);
}

/**
 * Models offered for the provider that is actually selected.
 *
 * Each provider publishes a different catalogue, so showing the ChatGPT list
 * while pointed at Anthropic would offer nothing but ids that fail at send
 * time. Hand-added ids stay across providers, since they are usually the whole
 * reason a provider was configured.
 */
export function selectableModels(): ModelOption[] {
  const provider = activeProvider();
  const base = provider.models.length ? provider.models : KNOWN_MODELS;
  const remote = remoteModelsByProvider.get(provider.id) ?? [];
  const seen = new Set<string>();
  return [...base, ...remote, ...discoveredModels].filter((model) => {
    const id = normaliseModelId(model.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const CANDIDATE_MODELS = KNOWN_MODELS.map((m) => m.id);

function probeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function tryModel(
  base: string,
  model: string,
  tokens: { accessToken: string; accountId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    throwIfAborted(signal);
    const requestSignal = probeRequestSignal(signal);
    const res = await fetch(`${base}/responses`, {
      method: 'POST',
      headers: headersFor(tokens.accessToken, tokens.accountId),
      signal: requestSignal,
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
        // This backend accepts streaming requests only, and refuses to persist
        // responses: anything else fails with "Stream must be set to true" or
        // "Store must be set to false".
        stream: true,
        store: false,
      }),
    });

    if (res.ok) {
      // The headers are the answer; don't pull the whole completion just to
      // learn the model is allowed.
      await res.body?.cancel();
      return { ok: true, status: res.status, detail: 'available' };
    }
    const text = await readBoundedResponseText(res, undefined, requestSignal);
    return { ok: false, status: res.status, detail: normaliseModelProbeDetail(text.slice(0, 240)) };
  } catch (e) {
    throwIfAborted(signal);
    return { ok: false, status: 0, detail: normaliseModelProbeDetail(e) };
  }
}

/**
 * Asks a provider what it actually serves.
 *
 * Every API-key provider exposes /models, which is both faster and more honest
 * than a hardcoded list — so for those the answer is the live catalogue rather
 * than a guess. Only the ChatGPT backend has no such endpoint, and there the
 * question is really "does my plan allow this", which only a real request can
 * answer.
 */
async function listRemoteModels(signal?: AbortSignal): Promise<{ id: string; ok: boolean; detail: string }[]> {
  throwIfAborted(signal);
  const provider = activeProvider();
  const key = loadApiKey(provider.id) ?? '';
  if (provider.needsKey && !key) {
    remoteModelsByProvider.delete(provider.id);
    return [{ id: '(no key)', ok: false, detail: `Add an API key for ${provider.label} first.` }];
  }

  const headers: Record<string, string> =
    provider.shape === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {};

  try {
    throwIfAborted(signal);
    const requestSignal = probeRequestSignal(signal);
    const res = await fetch(`${baseUrlFor(provider)}/models`, { headers, signal: requestSignal });
    if (!res.ok) {
      remoteModelsByProvider.delete(provider.id);
      const detail = normaliseModelProbeDetail((await readBoundedResponseText(res, undefined, requestSignal)).slice(0, 200));
      return [{ id: provider.label, ok: false, detail: `${res.status}: ${detail}` }];
    }
    const body = await readBoundedJson(res, undefined, requestSignal);
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const ids = normaliseRemoteModelIds(data);
    if (!ids.length) {
      remoteModelsByProvider.delete(provider.id);
      return [{ id: provider.label, ok: false, detail: 'No models returned.' }];
    }
    const results = ids.sort().map((id) => ({ id, ok: true, detail: 'available' }));
    remoteModelsByProvider.set(
      provider.id,
      results.map(({ id }) => ({ id, label: id, note: 'Discovered from the live provider catalogue' })),
    );
    return results;
  } catch (e) {
    throwIfAborted(signal);
    remoteModelsByProvider.delete(provider.id);
    return [{ id: provider.label, ok: false, detail: normaliseModelProbeDetail(e) }];
  }
}

/**
 * Tests every selectable model against the live account, so the UI can show
 * which ones this plan actually permits instead of failing at send time.
 */
export async function probeModels(
  extraIds: string[] = [],
  signal?: AbortSignal,
): Promise<{ id: string; ok: boolean; detail: string }[]> {
  throwIfAborted(signal);
  const provider = activeProvider();
  if (provider.id !== 'chatgpt') return listRemoteModels(signal);

  const tokens = await getValidTokens(signal);
  if (!tokens)
    return selectableModels().map((m) => ({ id: m.id, ok: false, detail: 'Not signed in.' }));

  const base = await baseUrl(signal);
  const results: { id: string; ok: boolean; detail: string }[] = [];
  const targets = [
    ...selectableModels(),
    ...extraIds
      .filter((id) => !selectableModels().some((m) => m.id === id))
      .map((id) => ({ id, label: id, note: 'Added by you' })),
  ];
  throwIfAborted(signal);
  for (const m of targets) {
    const r = await tryModel(base, m.id, tokens, signal);
    let detail = r.ok ? 'available' : `${r.status}: ${normaliseModelProbeDetail(r.detail)}`;
    const parsed = parseJsonRecord(r.detail);
    const error = isRecord(parsed?.error) ? parsed.error : undefined;
    const msg = typeof parsed?.detail === 'string' ? parsed.detail : typeof error?.message === 'string' ? error.message : undefined;
    if (!r.ok && msg) detail = normaliseModelProbeDetail(msg);
    results.push({ id: m.id, ok: r.ok, detail: normaliseModelProbeDetail(detail) });
  }
  return results;
}

export interface ProbeResult {
  ok: boolean;
  base: string;
  model?: string;
  detail: string;
  tried: { model: string; status: number; detail: string }[];
}

/**
 * Confirms which host accepts the credentials and which model this account can
 * actually use, so a wrong assumption surfaces as a clear diagnostic instead of
 * a confusing failure mid-conversation.
 */
export async function probeEndpoint(signal?: AbortSignal): Promise<ProbeResult> {
  throwIfAborted(signal);
  const tokens = await getValidTokens(signal);
  if (!tokens) return { ok: false, base: '', detail: 'Not signed in.', tried: [] };

  const tried: { model: string; status: number; detail: string }[] = [];

  throwIfAborted(signal);
  for (const base of [CODEX_BASE, PLATFORM_BASE]) {
    let hostAnswers = false;

    throwIfAborted(signal);
    for (const model of CANDIDATE_MODELS) {
      const r = await tryModel(base, model, tokens, signal);
      tried.push({ model, status: r.status, detail: r.detail });

      if (r.ok) {
        resolvedBase = base;
        return { ok: true, base, model, detail: `${base} accepted ${model}.`, tried };
      }
      // A 404 means the host itself is wrong; anything else means the host is
      // right and only this model was rejected, so keep trying models here.
      if (r.status === 404) break;
      hostAnswers = true;
      // Auth problems will not be fixed by another model id.
      if (r.status === 401 || r.status === 403) {
        return { ok: false, base, detail: `${base} -> ${r.status}: ${r.detail}`, tried };
      }
    }

    if (hostAnswers) {
      return {
        ok: false,
        base,
        detail: `${base} accepted the token but rejected every candidate model.`,
        tried,
      };
    }
  }
  return { ok: false, base: '', detail: 'Neither host answered.', tried };
}

let resolvedBase: string | null = null;

export function setBase(base: string): void {
  resolvedBase = base;
}

async function baseUrl(signal?: AbortSignal): Promise<string> {
  if (resolvedBase) return resolvedBase;
  const probe = await probeEndpoint(signal);
  if (probe.base) {
    resolvedBase = probe.base;
    return probe.base;
  }
  // Do not cache an unverified fallback after a transient outage. The current
  // request can still make one best-effort attempt, while the next request
  // gets a fresh chance to discover the alternate host.
  return CODEX_BASE;
}

/**
 * Streams one assistant turn from whichever access point is selected.
 *
 * The Responses path is kept inline because it carries two different
 * authentications against two different hosts — a ChatGPT subscription token
 * and a platform API key — while everything else is a straightforward adapter.
 */
export async function streamTurn(
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
  isRetry = false,
  reasoningEffort?: string,
  withoutTools = false,
  toolNames?: readonly string[],
  operationId?: OperationId,
): Promise<void> {
  const provider = activeProvider();

  if (provider.shape !== 'responses') {
    const key = loadApiKey(provider.id) ?? '';
    if (provider.needsKey && !key) {
      throw new Error(`No API key set for ${provider.label}. Add one in Settings.`);
    }
    const schemaSelection = withoutTools ? null : toolSchemaSelectionForNames(toolNames);
    const tools = schemaSelection?.selected ?? [];
    const available = schemaSelection?.available ?? [];
    const toolSelection = makeToolPayloadMetrics(provider.shape, available, tools);
    const selectionMode: ModelRequestSelectionMode = withoutTools
      ? 'none'
      : toolNames
        ? 'selected'
        : 'all';
    const req = {
      provider,
      baseUrl: baseUrlFor(provider),
      apiKey: key,
      model,
      messages,
      tools,
      toolSelection,
      toolSelectionMode: selectionMode,
      operationId,
      reasoningEffort: reasoningEffort ? normaliseEffort(reasoningEffort) : undefined,
      signal,
    };
    return provider.shape === 'anthropic'
      ? streamAnthropic(req, handlers)
      : streamChatCompletions(req, handlers);
  }

  return streamResponses(
    provider,
    model,
    messages,
    handlers,
    signal,
    isRetry,
    reasoningEffort,
    withoutTools,
    toolNames,
    operationId,
  );
}

async function streamResponses(
  provider: ProviderInfo,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
  isRetry = false,
  reasoningEffort?: string,
  withoutTools = false,
  toolNames?: readonly string[],
  operationId?: OperationId,
): Promise<void> {
  let url: string;
  let headers: Record<string, string>;

  if (provider.id === 'chatgpt') {
    const tokens = await getValidTokens(signal);
    if (!tokens) throw new Error('Not signed in.');
    url = `${await baseUrl(signal)}/responses`;
    headers = headersFor(tokens.accessToken, tokens.accountId);
  } else {
    const key = loadApiKey(provider.id);
    if (!key) throw new Error(`No API key set for ${provider.label}. Add one in Settings.`);
    url = `${baseUrlFor(provider)}/responses`;
    headers = apiKeyHeaders(key);
  }

  const schemaSelection = withoutTools ? null : toolSchemaSelectionForNames(toolNames);
  const tools = schemaSelection?.selected ?? [];
  const available = schemaSelection?.available ?? [];
  const toolSelection = makeToolPayloadMetrics(provider.shape, available, tools);
  const selectionMode: ModelRequestSelectionMode = withoutTools
    ? 'none'
    : toolNames
      ? 'selected'
      : 'all';
  const body: Record<string, unknown> = {
    model,
    input: toInput(messages),
    ...(withoutTools ? {} : { tools: toolDefs(tools), tool_choice: 'auto' }),
    parallel_tool_calls: false,
    stream: true,
    store: false,
    // Normalised here too: a bad effort value fails the whole request, and
    // the setting can be written from more than one place.
    ...(reasoningEffort ? { reasoning: { effort: normaliseEffort(reasoningEffort) } } : {}),
  };
  assertModelRequestWithinLimit(body);
  logModelRequestMetric({
    provider: provider.id,
    shape: provider.shape,
    model,
    operationId,
    selectionMode,
    ...toolSelection,
    requestBytes: jsonByteLength(body),
    retry: isRetry,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: stringifyJsonWithinLimit(body, MAX_MODEL_REQUEST_BYTES, 'Model request'),
    });
  } catch (error) {
    // A cancelled request is caller state, not endpoint evidence. Other
    // transport failures make the cached ChatGPT host untrustworthy for the
    // next turn, so let the next request rediscover it.
    if (provider.id === 'chatgpt' && !signal?.aborted) resolvedBase = null;
    throw error;
  }

  if (provider.id === 'chatgpt' && shouldInvalidateResolvedBase(res.status)) {
    resolvedBase = null;
  }

  // Which reasoning levels exist depends on the model, not just the API: a
  // level the API lists can still be refused by a particular model. Rather
  // than fail the turn, drop the parameter and let the model use its default.
  if (res.status === 400 && reasoningEffort) {
    let body: string;
    try {
      body = await readBoundedResponseText(res.clone(), 8_000, signal);
    } catch (error) {
      await cancelResponseBody(res);
      throw error;
    }
    if (/reasoning\.effort|is not supported with|Unsupported value/i.test(body)) {
      await cancelResponseBody(res);
      return streamResponses(provider, model, messages, handlers, signal, isRetry, undefined, withoutTools, toolNames, operationId);
    }
  }

  // A 401 mid-session usually means the access token aged out between our
  // expiry check and the request; refresh once and retry before giving up.
  if (res.status === 401 && !isRetry && provider.id === 'chatgpt') {
    try {
      const refreshed = await forceRefresh(signal);
      if (refreshed) {
        await cancelResponseBody(res);
        return streamResponses(provider, model, messages, handlers, signal, true, reasoningEffort, withoutTools, toolNames, operationId);
      }
    } catch (error) {
      await cancelResponseBody(res);
      throw error;
    }
  }
  if (!res.ok || !res.body) {
    const detail = await readBoundedResponseText(res, undefined, signal);
    throw new Error(`Model request failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  await consumeResponsesSse(res.body, handlers, signal);
}

/**
 * Whether a request could be sent at all right now.
 *
 * Signing in is not the only way to be usable any more — a pasted API key is
 * just as valid — so anything gating on "signed in" asks this instead.
 */
export async function haveCredentials(signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  const provider = activeProvider();
  if (provider.id === 'chatgpt') return !!(await getValidTokens(signal));
  throwIfAborted(signal);
  return !provider.needsKey || !!loadApiKey(provider.id);
}

/** Accumulates function_call arguments, which arrive in fragments. */
interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export async function consumeResponsesSse(body: ReadableStream<Uint8Array>, handlers: StreamHandlers, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<string, PendingCall>();
  let buffer = '';
  let textChars = 0;
  let toolCallCount = 0;
  let doneEmitted = false;
  const emitDone = () => {
    if (doneEmitted) return;
    doneEmitted = true;
    handlers.onDone();
  };

  try {
  while (true) {
    const { done, value } = await waitWithAbort(reader.read(), signal);
    if (done) break;
    buffer = streamBuffer(buffer, decodeModelStreamChunk(decoder, value));

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      const parsed = parseJsonRecord(payload);
      if (!parsed) continue;
      const evt = parsed;
      const type = typeof evt.type === 'string' ? evt.type : '';

      if (type === 'response.output_text.delta') {
        const delta = streamText(evt.delta, textChars, MAX_MODEL_TEXT_CHARS, 'Model text output');
        textChars += delta.length;
        handlers.onDelta(delta);
      } else if (type === 'response.output_item.added') {
        const item = isRecord(evt.item) ? evt.item : undefined;
        if (item?.type === 'function_call') {
          const name =
            item.name === undefined
              ? ''
              : streamIdentifier(item.name, 'Model tool name', MAX_MODEL_NAME_CHARS);
          const itemId =
            item.id === undefined ? undefined : streamIdentifier(item.id, 'Model tool item id');
          const callId =
            item.call_id === undefined ? undefined : streamIdentifier(item.call_id, 'Model tool call id');
          const key = itemId ?? callId;
          if (!key) throw new Error('Model function call was missing an id.');
          if (pending.has(key)) throw new Error('Model repeated a function call item.');
          if (++toolCallCount > MAX_MODEL_TOOL_CALLS) throw new Error('Model returned too many tool calls.');
          const toolCallId = callId ?? itemId;
          if (!toolCallId) throw new Error('Model function call was missing a call id.');
          pending.set(key, {
            id: toolCallId,
            name,
            args: '',
          });
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const key = streamIdentifier(evt.item_id, 'Model tool item id');
        const p = pending.get(key);
        if (!p) throw new Error('Model tool arguments referenced an unknown item.');
        p.args += streamText(evt.delta, p.args.length, MAX_MODEL_TOOL_ARGUMENT_CHARS, 'Model tool arguments');
      } else if (type === 'response.output_item.done') {
        const item = isRecord(evt.item) ? evt.item : undefined;
        if (item?.type === 'function_call') {
          const itemId =
            item.id === undefined ? undefined : streamIdentifier(item.id, 'Model tool item id');
          const callId =
            item.call_id === undefined ? undefined : streamIdentifier(item.call_id, 'Model tool call id');
          const key = itemId ?? callId;
          if (!key) throw new Error('Model function call was missing an id.');
          const p = pending.get(key);
          if (!p) throw new Error('Model function call completed without a matching start.');
          const rawArgs = streamText(item.arguments ?? p.args ?? '{}', 0, MAX_MODEL_TOOL_ARGUMENT_CHARS, 'Model tool arguments');
          const name = streamIdentifier(item.name ?? p.name, 'Model tool name', MAX_MODEL_NAME_CHARS);
          const parsed = parseJsonRecord(rawArgs || '{}') ?? { __parseError: rawArgs };
          handlers.onToolCall({
            id: callId ?? p.id,
            name,
            args: parsed,
          });
          pending.delete(key);
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        if (pending.size) throw new Error('Model stream ended with an incomplete tool call.');
        emitDone();
      } else if (type === 'response.failed' || type === 'error') {
        const response = isRecord(evt.response) ? evt.response : undefined;
        const err = isRecord(response?.error) ? response.error : evt;
        const message = typeof err.message === 'string' ? err.message : 'Model stream failed.';
        throw new Error(message.slice(0, 500));
      }
    }
  }
  if (pending.size) throw new Error('Model stream ended with an incomplete tool call.');
  emitDone();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
}
}
