import {
  APPROVAL_MODES,
  DEFAULT_SETTINGS,
  REASONING_LEVELS,
  isValidCompactionThreshold,
  isValidContextWindow,
  type Settings,
  normaliseEffort,
} from '../shared/types';
import { MAX_CUSTOM_MODELS, normaliseCustomModelIds, normaliseModelId } from './model/catalog';

const STRING_LIMITS: Partial<Record<keyof Settings, number>> = {
  model: 500,
  customBaseUrl: 4_000,
  providerModels: 100_000,
  voiceModel: 500,
  voiceName: 100,
  micDeviceId: 500,
  hotkey: 200,
  chromeProfileDir: 500,
  screenshotDir: 1_000,
  workspaceRoot: 1_000,
  customModels: MAX_CUSTOM_MODELS * 600,
};

const BOOLEAN_KEYS = new Set<keyof Settings>([
  'speakReplies',
  'privacyMode',
  'workspaceContextEnabled',
  'workspaceFileSearchEnabled',
  'goalContextEnabled',
  'learningMemoryEnabled',
  'launchOnStartup',
]);

/** Workspace consent writes are scoped to the root the renderer showed when the change began. */
export function workspaceConsentScopeMatches(
  key: keyof Settings,
  currentRoot: string,
  expectedRoot: unknown,
): boolean {
  if (key !== 'workspaceContextEnabled' && key !== 'workspaceFileSearchEnabled') return true;
  const expected = boundedString('workspaceRoot', expectedRoot).trim();
  return currentRoot.trim() === expected;
}

function isSettingsKey(value: unknown): value is keyof Settings {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, value);
}

function isSafeChromeProfileDir(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[\0\r\n\\/:*?"<>|]/.test(value)
  );
}

function boundedString(key: keyof Settings, value: unknown): string {
  if (typeof value !== 'string') throw new Error('Setting "' + key + '" must be text.');
  const limit = STRING_LIMITS[key] ?? 1_000;
  if (value.length > limit) throw new Error('Setting "' + key + '" exceeds ' + limit.toLocaleString() + ' characters.');
  return value;
}

export interface ValidatedSettingUpdate {
  key: keyof Settings;
  value: unknown;
}

/** Validates the untrusted renderer payload before it reaches durable settings. */
export function validateSettingUpdate(
  key: unknown,
  value: unknown,
  providerIds: readonly string[],
): ValidatedSettingUpdate {
  if (!isSettingsKey(key)) throw new Error('Unknown setting key.');

  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== 'boolean') throw new Error('Setting "' + key + '" must be true or false.');
    return { key, value };
  }

  switch (key) {
    case 'provider':
      if (typeof value !== 'string' || !providerIds.includes(value)) throw new Error('Unknown provider.');
      return { key, value };
    case 'approvalMode':
      if (typeof value !== 'string' || !APPROVAL_MODES.some((mode) => mode.id === value)) {
        throw new Error('Unknown approval mode.');
      }
      return { key, value };
    case 'reasoningEffort':
      if (typeof value !== 'string' || !REASONING_LEVELS.some((level) => level.id === value)) {
        throw new Error('Unknown reasoning effort.');
      }
      return { key, value };
    case 'chromeMode':
      if (value !== 'pet' && value !== 'system') throw new Error('Chrome mode must be pet or system.');
      return { key, value };
    case 'chromeProfileDir': {
      const clean = boundedString(key, value);
      if (!isSafeChromeProfileDir(clean)) {
        throw new Error('Chrome profile directory must be one safe, non-empty path segment.');
      }
      return { key, value: clean };
    }
    case 'compactionThreshold':
      if (!isValidCompactionThreshold(value)) throw new Error('Invalid compaction threshold.');
      return { key, value };
    case 'contextWindow':
      if (!isValidContextWindow(value)) throw new Error('Invalid context window.');
      return { key, value };
    case 'petScale':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) {
        throw new Error('Pet scale must be a finite number between 0.25 and 4.');
      }
      return { key, value };
    case 'petX':
    case 'petY':
      if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1_000_000 || value > 1_000_000)) {
        throw new Error('Pet position must be null or a bounded integer.');
      }
      return { key, value };
    case 'customModels': {
      const raw = boundedString(key, value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Custom models must be a JSON array.');
      }
      return { key, value: JSON.stringify(normaliseCustomModelIds(parsed)) };
    }
    case 'providerModels': {
      const raw = boundedString(key, value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Provider models must be a JSON object.');
      }
      return { key, value: JSON.stringify(normaliseProviderModels(parsed)) };
    }
    case 'model':
    case 'voiceModel': {
      const clean = normaliseModelId(boundedString(key, value));
      if (!clean) throw new Error('Setting "' + key + '" must contain a bounded model id.');
      return { key, value: clean };
    }
    default:
      return { key, value: boundedString(key, value) };
  }
}
const KNOWN_PROVIDER_IDS = new Set([
  'chatgpt',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'xai',
  'groq',
  'deepseek',
  'mistral',
  'together',
  'ollama',
  'lmstudio',
  'custom',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rebuilds the persisted provider -> last model map from known bounded values. */
export function normaliseProviderModels(value: unknown): Record<string, string> {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 100_000) return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!isRecord(parsed)) return {};

  const result: Record<string, string> = {};
  for (const provider of KNOWN_PROVIDER_IDS) {
    const model = normaliseModelId(parsed[provider]);
    if (model) result[provider] = model;
  }
  return result;
}

function hasStoredSetting(stored: Record<string, unknown>, key: keyof Settings): boolean {
  return Object.prototype.hasOwnProperty.call(stored, key);
}

function storedBoolean(
  stored: Record<string, unknown>,
  key: keyof Settings,
  fallback: boolean,
  invalidFallback = fallback,
): boolean {
  if (!hasStoredSetting(stored, key)) return fallback;
  return typeof stored[key] === 'boolean' ? stored[key] : invalidFallback;
}

function storedText(
  stored: Record<string, unknown>,
  key: keyof Settings,
  fallback: string,
  maximum: number,
): string {
  const value = stored[key];
  return typeof value === 'string' && value.length <= maximum ? value : fallback;
}

/** Rebuilds durable settings from known, bounded values and fails closed on malformed state. */
export function normaliseStoredSettings(stored: Record<string, unknown>): Settings {
  const settings = { ...DEFAULT_SETTINGS };

  const provider = stored.provider;
  settings.provider =
    typeof provider === 'string' && KNOWN_PROVIDER_IDS.has(provider)
      ? (provider as Settings['provider'])
      : DEFAULT_SETTINGS.provider;
  settings.model = normaliseModelId(stored.model) ?? DEFAULT_SETTINGS.model;
  settings.customBaseUrl = storedText(stored, 'customBaseUrl', DEFAULT_SETTINGS.customBaseUrl, 4_000);
  settings.providerModels = JSON.stringify(normaliseProviderModels(stored.providerModels));
  settings.voiceModel = normaliseModelId(stored.voiceModel) ?? DEFAULT_SETTINGS.voiceModel;
  settings.voiceName = storedText(stored, 'voiceName', DEFAULT_SETTINGS.voiceName, 100);
  settings.micDeviceId = storedText(stored, 'micDeviceId', DEFAULT_SETTINGS.micDeviceId, 500);
  settings.speakReplies = storedBoolean(stored, 'speakReplies', DEFAULT_SETTINGS.speakReplies);
  // An invalid privacy value stops outbound and capture access until the user
  // explicitly chooses a valid setting in the UI.
  settings.privacyMode = storedBoolean(stored, 'privacyMode', DEFAULT_SETTINGS.privacyMode, true);
  settings.hotkey = storedText(stored, 'hotkey', DEFAULT_SETTINGS.hotkey, 200);

  const approvalMode = stored.approvalMode;
  settings.approvalMode =
    typeof approvalMode === 'string' && APPROVAL_MODES.some((mode) => mode.id === approvalMode)
      ? (approvalMode as Settings['approvalMode'])
      : DEFAULT_SETTINGS.approvalMode;
  settings.reasoningEffort = normaliseEffort(stored.reasoningEffort);

  const chromeMode = stored.chromeMode;
  settings.chromeMode = chromeMode === 'pet' || chromeMode === 'system' ? chromeMode : DEFAULT_SETTINGS.chromeMode;
  const storedProfileDir = storedText(stored, 'chromeProfileDir', DEFAULT_SETTINGS.chromeProfileDir, 500);
  settings.chromeProfileDir = isSafeChromeProfileDir(storedProfileDir)
    ? storedProfileDir
    : DEFAULT_SETTINGS.chromeProfileDir;
  settings.screenshotDir = storedText(stored, 'screenshotDir', DEFAULT_SETTINGS.screenshotDir, 1_000);
  settings.workspaceRoot = storedText(stored, 'workspaceRoot', DEFAULT_SETTINGS.workspaceRoot, 1_000);
  settings.workspaceContextEnabled = storedBoolean(stored, 'workspaceContextEnabled', DEFAULT_SETTINGS.workspaceContextEnabled);
  settings.workspaceFileSearchEnabled = storedBoolean(stored, 'workspaceFileSearchEnabled', DEFAULT_SETTINGS.workspaceFileSearchEnabled);
  settings.goalContextEnabled = storedBoolean(stored, 'goalContextEnabled', DEFAULT_SETTINGS.goalContextEnabled);
  settings.learningMemoryEnabled = storedBoolean(stored, 'learningMemoryEnabled', DEFAULT_SETTINGS.learningMemoryEnabled);

  const rawCustomModels = stored.customModels;
  if (!hasStoredSetting(stored, 'customModels')) {
    settings.customModels = DEFAULT_SETTINGS.customModels;
  } else {
    try {
      const parsed = typeof rawCustomModels === 'string' ? JSON.parse(rawCustomModels) : rawCustomModels;
      settings.customModels = JSON.stringify(normaliseCustomModelIds(parsed));
    } catch {
      settings.customModels = DEFAULT_SETTINGS.customModels;
    }
  }

  settings.compactionThreshold = isValidCompactionThreshold(stored.compactionThreshold)
    ? stored.compactionThreshold
    : DEFAULT_SETTINGS.compactionThreshold;
  settings.contextWindow = isValidContextWindow(stored.contextWindow)
    ? stored.contextWindow
    : DEFAULT_SETTINGS.contextWindow;
  settings.petScale =
    typeof stored.petScale === 'number' &&
    Number.isFinite(stored.petScale) &&
    stored.petScale >= 0.25 &&
    stored.petScale <= 4
      ? stored.petScale
      : DEFAULT_SETTINGS.petScale;

  for (const key of ['petX', 'petY'] as const) {
    const value = stored[key];
    settings[key] =
      value === null ||
      (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= -1_000_000 &&
        value <= 1_000_000)
        ? value
        : DEFAULT_SETTINGS[key];
  }
  settings.launchOnStartup = storedBoolean(stored, 'launchOnStartup', DEFAULT_SETTINGS.launchOnStartup);

  return settings;
}
