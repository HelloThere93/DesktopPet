import { waitWithAbort } from '../abort';
import { stringifyJsonWithinLimit } from '../bounded-json';
import type { ChatMessage, ProviderInfo, ToolCall } from '../../shared/types';
import { logModelRequestMetric, type ModelRequestSelectionMode } from '../observability';
import type { OperationId } from '../operations';
import type { ToolSchema } from '../tools/registry';
import {
  type ToolPayloadMetrics,
  jsonByteLength,
  makeToolPayloadMetrics,
  toolPayloadForShape,
} from './tool-payload';
import { MAX_MODEL_NAME_CHARS, MAX_MODEL_TEXT_CHARS, MAX_MODEL_TOOL_ARGUMENT_CHARS, MAX_MODEL_TOOL_CALLS, decodeModelStreamChunk, streamBuffer, streamIdentifier, streamText, streamToolIndex } from './stream-limits';
import { cancelResponseBody, parseJsonRecord, readBoundedResponseText } from './response-bounds';
import { normaliseImageDataUrl } from '../attachments';
import { assertModelRequestWithinLimit, MAX_MODEL_REQUEST_BYTES } from './request-bounds';


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Request shapes other than the Responses API.
 *
 * Two are enough to reach almost every vendor: chat-completions, which OpenAI
 * defined and OpenRouter, Google, xAI, Groq, DeepSeek, Mistral, Together,
 * Ollama and LM Studio all imitate exactly, and Anthropic's messages API, which
 * is the one genuinely different wire format worth supporting directly.
 *
 * The awkward part is not the request but the history: our messages are stored
 * in Responses API terms, so each adapter has to translate tool calls and
 * results back into its own idea of a conversation.
 */

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onDone: () => void;
}

export interface AdapterRequest {
  provider: ProviderInfo;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  toolSelection?: ToolPayloadMetrics;
  toolSelectionMode?: ModelRequestSelectionMode;
  operationId?: OperationId;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

function logAdapterRequest(
  req: AdapterRequest,
  body: unknown,
  retry = false,
): void {
  const selection =
    req.toolSelection ?? makeToolPayloadMetrics(req.provider.shape, req.tools, req.tools);
  const selectionMode: ModelRequestSelectionMode =
    req.toolSelectionMode ?? (req.tools.length ? 'all' : 'none');
  logModelRequestMetric({
    provider: req.provider.id,
    shape: req.provider.shape,
    model: req.model,
    operationId: req.operationId,
    selectionMode,
    ...selection,
    requestBytes: jsonByteLength(body),
    retry,
  });
}

/* --------------------------------------------------------- chat completions */

interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ChatMessageOut {
  role: string;
  content: string | ChatContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toChatMessages(messages: ChatMessage[]): ChatMessageOut[] {
  const out: ChatMessageOut[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: stringifyJsonWithinLimit(c.args, 200_000, 'Model tool arguments') },
        })),
      });
      continue;
    }
    const imageDataUrl = normaliseImageDataUrl(m.imageDataUrl);
    if (imageDataUrl && m.role === 'user') {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export async function streamChatCompletions(
  req: AdapterRequest,
  handlers: StreamHandlers,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  if (req.provider.id === 'openrouter') {
    // OpenRouter attributes traffic by these; harmless everywhere else, but
    // only sent where it is actually read.
    headers['HTTP-Referer'] = 'https://github.com/adi-pet';
    headers['X-Title'] = 'Adi Pet';
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages: toChatMessages(req.messages),
    stream: true,
  };
  if (req.tools.length) {
    body.tools = toolPayloadForShape(req.provider.shape, req.tools);
    body.tool_choice = 'auto';
  }
  // Only the reasoning families accept this, and the rest reject the whole
  // request rather than ignoring it — so it is dropped and retried on 400.
  if (req.reasoningEffort && req.reasoningEffort !== 'none') {
    body.reasoning_effort = req.reasoningEffort;
  }

  assertModelRequestWithinLimit(body);
  logAdapterRequest(req, body);
  let res = await fetch(`${req.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal: req.signal,
    body: stringifyJsonWithinLimit(body, MAX_MODEL_REQUEST_BYTES, 'Model request'),
  });

  if (res.status === 400 && body.reasoning_effort) {
    await cancelResponseBody(res);
    delete body.reasoning_effort;
    assertModelRequestWithinLimit(body);
    logAdapterRequest(req, body, true);
    res = await fetch(`${req.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: stringifyJsonWithinLimit(body, MAX_MODEL_REQUEST_BYTES, 'Model request'),
    });
  }

  if (!res.ok || !res.body) {
    const detail = await readBoundedResponseText(res, undefined, req.signal);
    throw new Error(`${req.provider.label} request failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  await consumeChatSse(res.body, handlers, req.signal);
}

/** Tool calls arrive as fragments keyed by index, not by id. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

async function consumeChatSse(body: ReadableStream<Uint8Array>, handlers: StreamHandlers, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, PartialCall>();
  let buffer = '';
  let textChars = 0;
  let finished = false;
  const emittedCallIds = new Set<string>();

  const flush = () => {
    for (const c of calls.values()) {
      const id = streamIdentifier(c.id, 'Model tool call id');
      if (emittedCallIds.has(id)) throw new Error('Model returned a duplicate tool call id.');
      emittedCallIds.add(id);
      const name = streamIdentifier(c.name, 'Model tool name', MAX_MODEL_NAME_CHARS);
      const parsed = parseJsonRecord(c.args || '{}') ?? { __parseError: c.args };
      handlers.onToolCall({ id, name, args: parsed });
    }
    calls.clear();
  };

  try {
  while (!finished) {
    const { done, value } = await waitWithAbort(reader.read(), signal);
    if (done) break;
    buffer = streamBuffer(buffer, decodeModelStreamChunk(decoder, value));

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        finished = true;
        break;
      }

      let evt: {
        choices?: {
          delta?: {
            content?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string;
        }[];
        error?: { message?: string };
      };
      const parsed = parseJsonRecord(payload);
      if (!parsed) continue;
      evt = parsed as typeof evt;

      const providerError = isRecord(evt.error) ? evt.error : undefined;
      if (typeof providerError?.message === 'string' && providerError.message) {
        throw new Error(providerError.message.slice(0, 500));
      }

      const choice = Array.isArray(evt.choices) && isRecord(evt.choices[0]) ? evt.choices[0] : undefined;
      if (!choice) continue;
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (typeof delta?.content === 'string' && delta.content) {
        const text = streamText(delta.content, textChars, MAX_MODEL_TEXT_CHARS, 'Model text output');
        textChars += text.length;
        handlers.onDelta(text);
      }

      const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      for (const rawToolCall of toolCalls) {
        const tc = isRecord(rawToolCall) ? rawToolCall : undefined;
        if (!tc) continue;
        const key = streamToolIndex(tc.index);
        if (!calls.has(key) && calls.size >= MAX_MODEL_TOOL_CALLS) throw new Error('Model returned too many tool calls.');
        const existing = calls.get(key) ?? { id: '', name: '', args: '' };
        if (tc.id !== undefined) {
          const id = streamIdentifier(tc.id, 'Model tool call id');
          if (existing.id && existing.id !== id) throw new Error('Model tool call id changed mid-stream.');
          existing.id = id;
        }
        const fn = isRecord(tc.function) ? tc.function : undefined;
        if (typeof fn?.name === 'string' && fn.name) existing.name += streamText(fn.name, existing.name.length, MAX_MODEL_NAME_CHARS, 'Model tool name');
        if (typeof fn?.arguments === 'string' && fn.arguments) existing.args += streamText(fn.arguments, existing.args.length, MAX_MODEL_TOOL_ARGUMENT_CHARS, 'Model tool arguments');
        calls.set(key, existing);
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason) flush();
    }
  }

  flush();
  handlers.onDone();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
}
}

/* ---------------------------------------------------------------- anthropic */

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function dataUrlToBlock(dataUrl: string): AnthropicBlock | null {
  const safe = normaliseImageDataUrl(dataUrl);
  const m = safe ? /^data:([^;]+);base64,(.+)$/.exec(safe) : null;
  if (!m) return null;
  const mediaType = m[1];
  const data = m[2];
  if (!mediaType || !data) return null;
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/**
 * Rebuilds our flat history as Anthropic's alternating turns.
 *
 * Two structural differences bite: the system prompt is a top-level field
 * rather than a message, and tool results are user-turn content blocks rather
 * than messages of their own — so consecutive results have to be merged into a
 * single user turn or the API rejects the sequence.
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content || '(no output)' },
      ]);
      continue;
    }

    const blocks: AnthropicBlock[] = [];
    if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
    if (m.imageDataUrl && m.role === 'user') {
      const img = dataUrlToBlock(m.imageDataUrl);
      if (img) blocks.push(img);
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      }
    }
    push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
  }

  // The API requires the first turn to be from the user.
  while (out[0]?.role === 'assistant') out.shift();
  return { system, messages: out };
}

/** Effort maps onto a thinking budget; the lower levels simply do not think. */
function thinkingFor(effort?: string): { type: 'enabled'; budget_tokens: number } | undefined {
  switch (effort) {
    case 'high':
      return { type: 'enabled', budget_tokens: 8_000 };
    case 'xhigh':
      return { type: 'enabled', budget_tokens: 16_000 };
    case 'max':
      return { type: 'enabled', budget_tokens: 32_000 };
    default:
      return undefined;
  }
}

export async function streamAnthropic(
  req: AdapterRequest,
  handlers: StreamHandlers,
): Promise<void> {
  const { system, messages } = toAnthropicMessages(req.messages);
  const thinking = thinkingFor(req.reasoningEffort);
  // max_tokens has to leave room for the answer on top of the thinking budget.
  const maxTokens = (thinking?.budget_tokens ?? 0) + 8_000;

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    stream: true,
    messages,
  };
  if (system) body.system = system;
  if (thinking) body.thinking = thinking;
  if (req.tools.length) {
    body.tools = toolPayloadForShape(req.provider.shape, req.tools);
  }

  assertModelRequestWithinLimit(body);
  logAdapterRequest(req, body);
  const res = await fetch(`${req.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: req.signal,
    body: stringifyJsonWithinLimit(body, MAX_MODEL_REQUEST_BYTES, 'Model request'),
  });

  if (!res.ok || !res.body) {
    const detail = await readBoundedResponseText(res, undefined, req.signal);
    throw new Error(`Anthropic request failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  await consumeAnthropicSse(res.body, handlers, req.signal);
}

async function consumeAnthropicSse(body: ReadableStream<Uint8Array>, handlers: StreamHandlers, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks = new Map<number, PartialCall>();
  let buffer = '';
  let textChars = 0;
  const seenCallIds = new Set<string>();
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

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let evt: Record<string, unknown>;
      const parsed = parseJsonRecord(dataLine.slice(5).trim());
      if (!parsed) continue;
      evt = parsed;

      const type = typeof evt.type === 'string' ? evt.type : '';
      const indexRequired = type === 'content_block_start' || type === 'content_block_delta' || type === 'content_block_stop';
      const index = indexRequired ? streamToolIndex(evt.index) : -1;

      if (type === 'content_block_start') {
        const block = isRecord(evt.content_block) ? evt.content_block : undefined;
        if (block?.type === 'tool_use') {
          if (blocks.has(index)) throw new Error('Model repeated an Anthropic tool block index.');
          if (blocks.size >= MAX_MODEL_TOOL_CALLS) throw new Error('Model returned too many tool calls.');
          const id = streamIdentifier(block.id, 'Model tool call id');
          if (seenCallIds.has(id)) throw new Error('Model returned a duplicate tool call id.');
          seenCallIds.add(id);
          const name = streamIdentifier(block.name, 'Model tool name', MAX_MODEL_NAME_CHARS);
          blocks.set(index, { id, name, args: '' });
        }
      } else if (type === 'content_block_delta') {
        const delta = isRecord(evt.delta) ? evt.delta : undefined;
        if (delta?.type === 'text_delta') {
          const text = streamText(delta.text, textChars, MAX_MODEL_TEXT_CHARS, 'Model text output');
          textChars += text.length;
          handlers.onDelta(text);
        }
        else if (delta?.type === 'input_json_delta') {
          const b = blocks.get(index);
           if (!b) throw new Error('Model tool arguments referenced an unknown block.');
           b.args += streamText(delta.partial_json, b.args.length, MAX_MODEL_TOOL_ARGUMENT_CHARS, 'Model tool arguments');
        }
      } else if (type === 'content_block_stop') {
        const b = blocks.get(index);
        if (!b) throw new Error('Model tool block stopped without a matching start.');
        const parsed = parseJsonRecord(b.args || '{}') ?? { __parseError: b.args };
        handlers.onToolCall({ id: b.id, name: b.name, args: parsed });
        blocks.delete(index);
      } else if (type === 'error') {
        const err = isRecord(evt.error) ? evt.error : undefined;
        const message = typeof err?.message === 'string' ? err.message : 'Anthropic stream failed.';
        throw new Error(message.slice(0, 500));
      } else if (type === 'message_stop') {
        if (blocks.size) throw new Error('Model stream ended with an incomplete tool block.');
        emitDone();
      }
    }
  }
  if (blocks.size) throw new Error('Model stream ended with an incomplete tool block.');
  emitDone();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
}
}
