import { safeStorage } from 'electron';
import { deleteCredential, getSettings, loadCredential, saveCredential } from '../db';
import type { ProviderId, ProviderInfo } from '../../shared/types';
import { MAX_PROVIDER_KEY_CHARS } from '../ipc-validation';

/**
 * The access points requests can go through.
 *
 * Only three request shapes exist in practice: the Responses API, the
 * chat-completions API that most vendors now imitate byte for byte, and
 * Anthropic's messages API. Adding a vendor is therefore usually just a base
 * URL and a model list, which is why this is a table rather than a class per
 * provider.
 *
 * Model lists are a starting point, not an authority — vendors ship and retire
 * ids constantly, so every provider also accepts a model id typed by hand.
 */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT subscription',
    shape: 'responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    needsKey: false,
    note: 'Signed in with your ChatGPT account. No API key, no per-token billing.',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Strongest at coding and computer use' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Balanced default' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Fastest' },
      { id: 'gpt-5.3-codex-spark', label: 'Codex Spark', note: 'Near-instant; Pro only' },
      { id: 'gpt-5.5', label: 'GPT-5.5', note: 'Retires 2026-08-31' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API key',
    shape: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Billed per token against your platform account.',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    shape: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Most capable' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Balanced' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'Fastest' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    shape: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key, hundreds of models from every vendor.',
    models: [
      { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
      { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    shape: 'chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Uses the OpenAI-compatible endpoint Google publishes.',
    models: [
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    shape: 'chat',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    shape: 'chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Very fast inference of open models.',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'qwen3-32b', label: 'Qwen3 32B' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    shape: 'chat',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    shape: 'chat',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'mistral-small-latest', label: 'Mistral Small' },
    ],
  },
  {
    id: 'together',
    label: 'Together AI',
    shape: 'chat',
    baseUrl: 'https://api.together.xyz/v1',
    needsKey: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    models: [
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick' },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct', label: 'Qwen3 235B' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    shape: 'chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    note: 'Runs on this PC. Nothing leaves the machine. Start Ollama first.',
    models: [
      { id: 'llama3.2', label: 'Llama 3.2' },
      { id: 'qwen2.5-coder', label: 'Qwen2.5 Coder' },
    ],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    shape: 'chat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    note: 'Runs on this PC. Start the LM Studio server first.',
    models: [{ id: 'local-model', label: 'Whatever is loaded' }],
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    shape: 'chat',
    baseUrl: '',
    needsKey: true,
    note: 'Any server speaking /chat/completions. Set the base URL below.',
    models: [],
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const provider = PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
  if (!provider) throw new Error('No model providers are configured.');
  return provider;
}

export function activeProvider(): ProviderInfo {
  return providerInfo(getSettings().provider);
}

/** Base URL for a provider, honouring the custom override. */
export function baseUrlFor(p: ProviderInfo): string {
  if (p.id === 'custom') {
    const url = getSettings().customBaseUrl.trim().replace(/\/+$/, '');
    if (!url) throw new Error('Set a base URL for the custom provider in Settings.');
    return url;
  }
  return p.baseUrl;
}

function requireKnownProvider(value: unknown): ProviderId {
  if (typeof value !== 'string' || !PROVIDERS.some((provider) => provider.id === value)) {
    throw new Error('A valid provider id is required.');
  }
  return value as ProviderId;
}

/* ------------------------------------------------------------------ keys */

/**
 * API keys live in the same encrypted credential table as the OAuth tokens —
 * DPAPI ciphertext, never plaintext on disk. They are also never handed to the
 * renderer: the UI only ever learns whether one is set and its last four
 * characters, which is enough to tell two keys apart and useless if leaked.
 */
function credId(provider: ProviderId): string {
  return `apikey:${provider}`;
}

export function saveApiKey(provider: ProviderId, key: string): void {
  const safeProvider = requireKnownProvider(provider);
  if (typeof key !== 'string' || key.length > MAX_PROVIDER_KEY_CHARS) throw new Error('Provider key exceeds the safe size limit.');
  const clean = key.trim();
  if (!clean) {
    deleteCredential(credId(safeProvider));
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable — refusing to store a key in plaintext.',
    );
  }
  saveCredential(credId(safeProvider), safeStorage.encryptString(clean));
}

export function loadApiKey(provider: ProviderId): string | null {
  const blob = loadCredential(credId(provider));
  if (!blob) return null;
  try {
    return safeStorage.decryptString(blob);
  } catch {
    return null;
  }
}

export function clearApiKey(provider: ProviderId): void {
  deleteCredential(credId(requireKnownProvider(provider)));
}

/** What the settings pane is allowed to know about a stored key. */
export function keyStatus(provider: ProviderId): { set: boolean; hint: string } {
  const key = loadApiKey(provider);
  if (!key) return { set: false, hint: '' };
  return { set: true, hint: `…${key.slice(-4)}` };
}

/** Every provider that could serve a request right now. */
export function configuredProviders(): ProviderId[] {
  return PROVIDERS.filter((p) => !p.needsKey || !!loadApiKey(p.id)).map((p) => p.id);
}
