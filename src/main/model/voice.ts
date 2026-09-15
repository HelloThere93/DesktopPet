import type { BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { getValidTokens } from '../auth/oauth';
import { loadApiKey } from './providers';
import { getSettings } from '../db';
import { redactSecrets } from '../redaction';
import { isPcm16Base64Chunk, isVoiceEvent, MAX_VOICE_TEXT_CHARS } from '../ipc-validation';
import { boundedWebSocketText, parseJsonRecord } from './response-bounds';

/**
 * Speech in and out, over the realtime socket.
 *
 * Everything goes through this one connection because it is the only speech
 * surface this account can reach: the REST endpoints (/v1/audio/speech and
 * /v1/audio/transcriptions) authenticate fine with a ChatGPT subscription token
 * but answer 429 "exceeded your current quota", since they bill against
 * platform credits. The realtime socket does not.
 *
 * Two independent jobs:
 *
 *  - Dictation. Turn detection runs with create_response off, so speech is
 *    transcribed and nothing is generated. The text lands in the message box
 *    for the user to read, edit and send themselves.
 *  - Speaking. A reply is read aloud on request, which is a separate switch —
 *    you may want to dictate silently, or type and be answered aloud.
 *
 * Note this is the GA realtime shape. The old `OpenAI-Beta: realtime=v1` header
 * was retired on 2026-06-03 and now fails with beta_api_shape_disabled even
 * when the token is perfectly good, which reads like an auth error and is not.
 */
const REALTIME_HOST = 'wss://api.openai.com/v1/realtime';

export const VOICE_MODELS = ['gpt-realtime-2', 'gpt-realtime'];

function safeVoiceMessage(value: unknown): string {
  const text = redactSecrets(value instanceof Error ? value.message : String(value ?? 'Voice error.'));
  return text.length > 500 ? text.slice(0, 499) + '…' : text;
}

export type VoiceEvent =
  | { type: 'open'; model: string }
  | { type: 'listening'; on: boolean }
  | { type: 'user-transcript'; text: string }
  | { type: 'speaking'; on: boolean }
  | { type: 'audio'; base64: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normaliseVoiceRealtimeEvent(value: unknown, dictating: boolean): VoiceEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return isPcm16Base64Chunk(value.delta) ? { type: 'audio', base64: value.delta } : null;
    case 'conversation.item.input_audio_transcription.completed': {
      if (!dictating || typeof value.transcript !== 'string') return null;
      const text = value.transcript.trim();
      return text && text.length <= MAX_VOICE_TEXT_CHARS ? { type: 'user-transcript', text } : null;
    }
    case 'input_audio_buffer.speech_started':
      return { type: 'listening', on: true };
    case 'input_audio_buffer.speech_stopped':
      return { type: 'listening', on: false };
    case 'response.done':
    case 'response.output_audio.done':
      return { type: 'speaking', on: false };
    case 'error': {
      const error = isRecord(value.error) ? value.error : undefined;
      const message = typeof error?.message === 'string' ? error.message : 'Voice error.';
      const code = typeof error?.code === 'string' ? error.code.slice(0, 200) : '';
      return { type: 'error', message: safeVoiceMessage(message + (code ? ' (' + code + ')' : '')) };
    }
    default:
      return null;
  }
}

export interface VoiceGeneration {
  begin(): number;
  invalidate(): number;
  isCurrent(generation: number): boolean;
}

export function createVoiceGeneration(): VoiceGeneration {
  let current = 0;
  return {
    begin(): number {
      return ++current;
    },
    invalidate(): number {
      return ++current;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
  };
}

let dictating = false;
const dictationGeneration = createVoiceGeneration();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export interface VoiceSocketLease<T> {
  socket: T;
  generation: number;
}

export function createVoiceSocketLease<T>() {
  let current: VoiceSocketLease<T> | null = null;
  let generation = 0;
  return {
    claim(socket: T): VoiceSocketLease<T> {
      const lease = { socket, generation: ++generation };
      current = lease;
      return lease;
    },
    current(): VoiceSocketLease<T> | null {
      return current;
    },
    isCurrent(lease: VoiceSocketLease<T>): boolean {
      return current !== null &&
        current.socket === lease.socket &&
        current.generation === lease.generation;
    },
    release(lease: VoiceSocketLease<T>): boolean {
      if (
        current === null ||
        current.socket !== lease.socket ||
        current.generation !== lease.generation
      ) {
        return false;
      }
      current = null;
      return true;
    },
  };
}

const socketLeases = createVoiceSocketLease<WebSocket>();
let opening: Promise<boolean> | null = null;
let cancelOpening: (() => void) | null = null;

/**
 * The socket is kept warm briefly after use.
 *
 * Opening it costs a second or two, and tearing it down the moment dictation
 * stops meant paying that on every single press of the microphone — which is
 * most of what made speaking to it feel clunky. It closes itself once it has
 * genuinely gone unused.
 */
const IDLE_CLOSE_MS = 120_000;
const MAX_VOICE_MESSAGE_CHARS = 100_000;

function keepWarm(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!dictating) close();
  }, IDLE_CLOSE_MS);
}

function send(win: BrowserWindow, event: VoiceEvent) {
  if (!isVoiceEvent(event)) return;
  if (!win.isDestroyed()) win.webContents.send('voice', event);
}

export function isOpen(): boolean {
  const active = socketLeases.current()?.socket;
  return !!active && active.readyState === WebSocket.OPEN;
}

/** Opens the socket if needed, resolving only once it is genuinely up. */
function closeSocketQuietly(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  } catch {
    /* already closing */
  }
}

export function destroyVoiceUpgradeResponse(response: { destroy?: () => void } | null): void {
  try {
    response?.destroy?.();
  } catch {
    /* the handshake response may already be closed */
  }
}

function sendSocketPayload(ws: WebSocket, payload: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function openSocket(win: BrowserWindow, signal: AbortSignal): Promise<boolean> {
  const tokens = await getValidTokens(signal);
  if (signal.aborted) return false;

  const apiKey = tokens ? null : loadApiKey('openai');
  if (!tokens && !apiKey) {
    send(win, {
      type: 'error',
      message: 'Voice needs a ChatGPT sign-in or an OpenAI API key. Add one in Settings.',
    });
    return false;
  }

  const settings = getSettings();
  const model = settings.voiceModel || VOICE_MODELS[0] || 'gpt-realtime-2';

  const headers: Record<string, string> = tokens
    ? { Authorization: 'Bearer ' + tokens.accessToken, originator: 'codex_cli_rs' }
    : { Authorization: 'Bearer ' + apiKey };
  if (tokens?.accountId) headers['chatgpt-account-id'] = tokens.accountId;

  let ws: WebSocket;
  try {
    ws = new WebSocket(
      REALTIME_HOST + '?model=' + encodeURIComponent(model),
      { headers },
    );
  } catch (error) {
    send(win, { type: 'error', message: safeVoiceMessage(error) });
    return false;
  }

  const lease = socketLeases.claim(ws);
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const opened = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(ok);
    };

    ws.on('open', () => {
      if (settled) return;
      if (!socketLeases.isCurrent(lease) || signal.aborted) {
        finish(false);
        closeSocketQuietly(ws);
        return;
      }
      const sent = sendSocketPayload(ws, {
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'whisper-1' },
              // create_response off is what makes this dictation rather than a
              // conversation: it listens and transcribes, and answers only when
              // explicitly asked to.
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                // Short enough that a finished sentence lands promptly; long
                // enough to survive the pause in the middle of one.
                silence_duration_ms: 480,
                prefix_padding_ms: 260,
                create_response: false,
                interrupt_response: false,
              },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: settings.voiceName || 'marin',
            },
          },
        },
      });
      if (!sent) {
        finish(false);
        closeSocketQuietly(ws);
        return;
      }
      send(win, { type: 'open', model });
      finish(true);
    });

    ws.once('error', () => finish(false));
    ws.once('unexpected-response', (_req, res) => {
      destroyVoiceUpgradeResponse(res);
      send(win, {
        type: 'error',
        message: 'Voice endpoint refused the connection (' + res.statusCode + ').',
      });
      finish(false);
    });

    ws.on('message', (raw) => {
      if (!socketLeases.isCurrent(lease)) return;
      try {
        const text = boundedWebSocketText(raw, MAX_VOICE_MESSAGE_CHARS);
        if (!text) return;
        const event = normaliseVoiceRealtimeEvent(parseJsonRecord(text), dictating);
        if (event) send(win, event);
      } catch (error) {
        if (!socketLeases.isCurrent(lease)) return;
        send(win, { type: 'error', message: safeVoiceMessage(error) });
        closeSocketQuietly(ws);
      }
    });

    ws.on('close', (code, reason) => {
      finish(false);
      if (!socketLeases.release(lease)) return;
      dictating = false;
      send(win, { type: 'closed', reason: safeVoiceMessage(reason?.toString() || 'closed (' + code + ')') });
    });

    ws.on('error', (e) => {
      if (socketLeases.isCurrent(lease)) {
        send(win, { type: 'error', message: safeVoiceMessage(e) });
      }
    });

    timeout = setTimeout(() => finish(false), 12_000);
  });

  const ok = await opened;
  if (!ok || signal.aborted || !socketLeases.isCurrent(lease) || ws.readyState !== WebSocket.OPEN) {
    socketLeases.release(lease);
    closeSocketQuietly(ws);
    return false;
  }
  return true;
}

async function ensureSocket(win: BrowserWindow): Promise<boolean> {
  if (isOpen()) return true;
  if (opening) return opening;

  const controller = new AbortController();
  const attempt = openSocket(win, controller.signal);
  opening = attempt;
  cancelOpening = () => controller.abort();
  try {
    return await attempt;
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    if (opening === attempt) {
      opening = null;
      cancelOpening = null;
    }
  }
}
/* ------------------------------------------------------------- dictation */

export async function startDictation(win: BrowserWindow): Promise<boolean> {
  const generation = dictationGeneration.begin();
  if (idleTimer) clearTimeout(idleTimer);
  const ok = await ensureSocket(win);
  if (!dictationGeneration.isCurrent(generation)) return false;
  dictating = ok && isOpen();
  return dictating;
}

/** Opens the connection ahead of time so the first press has nothing to wait for. */
export async function prewarm(win: BrowserWindow): Promise<void> {
  if (isOpen()) return;
  const ok = await ensureSocket(win);
  if (ok && isOpen()) keepWarm();
}

export function stopDictation(): void {
  dictationGeneration.invalidate();
  dictating = false;
  const active = socketLeases.current()?.socket;
  if (active && active.readyState === WebSocket.OPEN) {
    // Drop anything half-heard so it cannot arrive after the mic is off.
    sendSocketPayload(active, { type: 'input_audio_buffer.clear' });
  }
  // Held open for a couple of minutes so the next press is instant.
  keepWarm();
}

/** Microphone audio, base64 PCM16 at 24kHz mono. */
export function pushAudio(base64: unknown): void {
  const active = socketLeases.current()?.socket;
  if (!isPcm16Base64Chunk(base64) || !dictating || !active || active.readyState !== WebSocket.OPEN) return;
  sendSocketPayload(active, { type: 'input_audio_buffer.append', audio: base64 });
}
/* -------------------------------------------------------------- speaking */

/**
 * Reads a reply aloud.
 *
 * The realtime model is a conversational model, not a text-to-speech engine, so
 * it is told plainly to perform the text rather than respond to it — otherwise
 * it answers the reply instead of reading it.
 */
export async function speak(win: BrowserWindow, text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  if (!(await ensureSocket(win))) return;

  const active = socketLeases.current()?.socket;
  if (!active || active.readyState !== WebSocket.OPEN) return;
  send(win, { type: 'speaking', on: true });
  keepWarm();
  if (!sendSocketPayload(active, {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions:
        'Read the following text aloud, word for word, as if you were saying it. ' +
        'Do not reply to it, summarise it, or add anything. Skip code blocks and ' +
        'read symbols naturally.\n\n' +
        clean.slice(0, 4000),
    },
  })) {
    send(win, { type: 'error', message: 'Voice connection closed before speech could start.' });
  }
}

export function stopSpeaking(): void {
  const active = socketLeases.current()?.socket;
  if (!active || active.readyState !== WebSocket.OPEN) return;
  sendSocketPayload(active, { type: 'response.cancel' });
}

export function close(): void {
  dictationGeneration.invalidate();
  dictating = false;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  cancelOpening?.();
  const lease = socketLeases.current();
  if (!lease) return;
  closeSocketQuietly(lease.socket);
}
