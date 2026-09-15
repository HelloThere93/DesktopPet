import { app } from 'electron';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types';
import { isOperationCancellation, throwIfAborted, waitWithAbort } from './abort';
import {
  databaseHealth,
  getSettings,
  recentAudit,
  type AuditSummary,
} from './db';
import * as goals from './goals';
import { getJobManager } from './job-runtime';
import * as mcp from './mcp/client';
import { haveCredentials, probeEndpoint, probeModels } from './model/client';
import { providerInfo } from './model/providers';
import { allToolCatalog, allToolSchemas } from './tools/registry';
import { reminderCount } from './tools/reminders';
import { loadProjects } from './projects';
import { redactSecrets } from './redaction';
import { validateWorkspaceRoot } from './workspace';

export type DiagnosticStatus = 'ok' | 'warning' | 'error';

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface DiagnosticFailure {
  source: 'audit' | 'runtime';
  label: string;
  detail: string;
  at: number;
  errorCode?: string;
}

export interface DiagnosticsSnapshot {
  checkedAt: number;
  checks: DiagnosticCheck[];
  recentFailures: DiagnosticFailure[];
  metrics: {
    recentAuditEntries: number;
    recentRuntimeErrors: number;
    recentModelRequests: number;
    averageToolMs?: number;
    slowestToolMs?: number;
  };
}

function check(
  id: string,
  label: string,
  status: DiagnosticStatus,
  detail: string,
): DiagnosticCheck {
  return { id, label, status, detail: redactSecrets(detail).slice(0, 500) };
}

function readTail(filePath: string, maxBytes = 128 * 1024): string {
  let fd: number | undefined;
  try {
    const bytes = statSync(filePath).size;
    const length = Math.min(bytes, maxBytes);
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, bytes - length));
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readJsonlTail(fileName: string, limit = 50): Record<string, unknown>[] {
  try {
    const text = readTail(join(app.getPath('userData'), 'logs', fileName));
    const records: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-limit)) {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          records.push(value as Record<string, unknown>);
        }
      } catch {
        // A partially written final log line is not a diagnostic failure.
      }
    }
    return records;
  } catch {
    return [];
  }
}
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const MAX_DIAGNOSTIC_FAILURE_LABEL_CHARS = 240;
const MAX_DIAGNOSTIC_FAILURE_DETAIL_CHARS = 4_000;
const MAX_DIAGNOSTIC_ERROR_CODE_CHARS = 120;
const MAX_DIAGNOSTIC_DURATION_MS = 86_400_000;

export function boundedDiagnosticDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DIAGNOSTIC_DURATION_MS
    ? value
    : undefined;
}

export function boundedDiagnosticText(value: unknown, maximum: number, fallback: string): string {
  try {
    const text = redactSecrets(typeof value === 'string' ? value : String(value ?? '')).trim();
    return text ? text.slice(0, Math.max(1, maximum)).trimEnd() : fallback;
  } catch {
    return fallback;
  }
}

function failureFromAudit(row: AuditSummary): DiagnosticFailure {
  const errorCode = typeof row.errorCode === 'string'
    ? boundedDiagnosticText(row.errorCode, MAX_DIAGNOSTIC_ERROR_CODE_CHARS, '')
    : '';
  const detail = errorCode ? `${errorCode}: ${row.decision}` : row.decision;
  const at = numberValue(row.createdAt);
  return {
    source: 'audit',
    label: boundedDiagnosticText(row.toolName, MAX_DIAGNOSTIC_FAILURE_LABEL_CHARS, 'audit failure'),
    detail: boundedDiagnosticText(detail, MAX_DIAGNOSTIC_FAILURE_DETAIL_CHARS, 'Audit failure.'),
    at: at !== undefined && at >= 0 ? at : Date.now(),
    ...(errorCode ? { errorCode } : {}),
  };
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const requestSignal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => work(requestSignal));
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Diagnostic probe timed out.'));
      controller.abort();
    }, milliseconds);
  });
  try {
    return await waitWithAbort(Promise.race([operation, timeout]), parentSignal);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function apiCheck(
  provider: ReturnType<typeof providerInfo>,
  credentials: boolean,
  signal?: AbortSignal,
): Promise<DiagnosticCheck> {
  if (!credentials) {
    return check(
      'api',
      'Model/API',
      'warning',
      provider.label + ' is configured, but no usable credentials were found.',
    );
  }

  try {
    if (provider.id === 'chatgpt') {
      const result = await withTimeout((probeSignal) => probeEndpoint(probeSignal), 15_000, signal);
      return check(
        'api',
        'Model/API',
        result.ok ? 'ok' : 'error',
        result.ok ? provider.label + ' accepted a live model request.' : result.detail,
      );
    }

    const models = await withTimeout((probeSignal) => probeModels([], probeSignal), 15_000, signal);
    const available = models.filter((model) => model.ok).length;
    return check(
      'api',
      'Model/API',
      available > 0 ? 'ok' : 'error',
      available > 0
        ? provider.label + ' returned ' + available + ' usable model(s).'
        : provider.label + ' returned no usable models.',
    );
  } catch (error) {
    if (isOperationCancellation(error)) throw error;
    return check(
      'api',
      'Model/API',
      'error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function externalDiagnosticsAllowed(privacyMode: boolean, settingsAvailable = true): boolean {
  return settingsAvailable && !privacyMode;
}

export async function runDiagnostics(signal?: AbortSignal): Promise<DiagnosticsSnapshot> {
  const checkedAt = Date.now();
  const checks: DiagnosticCheck[] = [];
  const recentFailures: DiagnosticFailure[] = [];
  let recentAuditEntries: AuditSummary[] = [];

  try {
    const health = databaseHealth();
    checks.push(
      check(
        'database',
        'Database',
        'ok',
        health.conversations +
          ' conversations, ' +
          health.messages +
          ' messages, and ' +
          health.auditEntries +
          ' audit entries.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'database',
        'Database',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  let settings = { ...DEFAULT_SETTINGS, privacyMode: true };
  let provider = providerInfo(DEFAULT_SETTINGS.provider);
  let settingsAvailable = false;
  try {
    settings = getSettings();
    provider = providerInfo(settings.provider);
    settingsAvailable = true;
  } catch (error) {
    checks.push(
      check(
        'settings',
        'Settings',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  let credentials = false;
  if (!settingsAvailable) {
    checks.push(
      check(
        'model',
        'Model configuration',
        'error',
        'Settings could not be loaded; model configuration was not verified.',
      ),
    );
    checks.push(
      check(
        'api',
        'Model/API',
        'warning',
        'Settings could not be loaded; live account and model probes were skipped.',
      ),
    );
  } else {
    try {
      checks.push(
        check(
          'model',
          'Model configuration',
          settings.model ? 'ok' : 'warning',
          provider.label + ' / ' + (settings.model || 'no model selected') + '.',
        ),
      );
      if (externalDiagnosticsAllowed(settings.privacyMode, settingsAvailable)) {
        credentials = await haveCredentials(signal);
        throwIfAborted(signal);
        const api = await apiCheck(provider, credentials, signal);
        throwIfAborted(signal);
        checks.push(api);
      } else {
        checks.push(
          check('api', 'Model/API', 'warning', 'Privacy pause is on; live account and model probes were skipped.'),
        );
      }
    } catch (error) {
      if (isOperationCancellation(error)) {
        checks.push(
          check('api', 'Model/API', 'warning', 'Live account and model probes were cancelled before completion.'),
        );
      } else {
        checks.push(
          check(
            'api',
            'Model/API',
            'error',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
  try {
    const servers = mcp.status();
    const unhealthy = servers.filter((server) => !server.disabled && (!server.connected || server.toolError));
    checks.push(
      check(
        'mcp',
        'MCP integrations',
        unhealthy.length ? 'warning' : 'ok',
        servers.length
          ? servers.length +
              ' configured; ' +
              servers.filter((server) => server.connected).length +
              ' connected; ' +
              unhealthy.length +
              ' need attention.'
          : 'No MCP servers configured.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'mcp',
        'MCP integrations',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const catalog = allToolCatalog();
    const callable = allToolSchemas().length;
    const unavailable = catalog.length - callable;
    checks.push(
      check(
        'tool-registry',
        'Tool registry',
        callable > 0 ? 'ok' : 'error',
        catalog.length +
          ' catalog entries; ' +
          callable +
          ' callable; ' +
          unavailable +
          ' unavailable or degraded.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'tool-registry',
        'Tool registry',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const projects = loadProjects();
    const active = projects.filter((project) => project.status === 'active' || project.status === 'paused').length;
    const workspace = settings.workspaceRoot.trim();
    let workspaceDetail = workspace ? 'selected workspace is configured' : 'no workspace folder selected';
    let workspaceStatus: DiagnosticStatus = workspace ? 'ok' : 'warning';
    if (workspace) {
      try {
        validateWorkspaceRoot(workspace);
      } catch (error) {
        workspaceStatus = 'error';
        workspaceDetail = error instanceof Error ? error.message : String(error);
      }
    }
    checks.push(
      check(
        'workspace',
        'Projects/workspace',
        workspaceStatus,
        active + ' active or paused project(s); ' + workspaceDetail + '.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'workspace',
        'Projects/workspace',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const activeGoals = goals.loadGoals().filter((goal) => goal.status === 'active');
    const watched = activeGoals.filter((goal) => goal.watch).length;
    const reminders = reminderCount();
    checks.push(
      check(
        'automation',
        'Automation',
        'ok',
        activeGoals.length +
          ' active goal(s), ' +
          watched +
          ' watched goal(s), and ' +
          reminders +
          ' reminder(s).',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'automation',
        'Automation',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const jobs = getJobManager().list();
    const pending = jobs.filter((job) =>
      ['queued', 'running', 'waiting', 'waiting-for-user'].includes(job.status),
    ).length;
    const failed = jobs.filter((job) => job.status === 'failed').length;
    checks.push(
      check(
        'background',
        'Background queue',
        failed ? 'warning' : 'ok',
        jobs.length +
          ' retained job(s); ' +
          pending +
          ' pending; ' +
          failed +
          ' failed.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'background',
        'Background queue',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  try {
    const lessonPath = join(app.getPath('userData'), 'lessons.md');
    const bytes = existsSync(lessonPath) ? statSync(lessonPath).size : 0;
    checks.push(
      check(
        'memory',
        'Planning/memory',
        bytes > 0 ? 'ok' : 'warning',
        bytes > 0
          ? 'Saved lesson store is ' + bytes + ' bytes; automatic sharing is ' + (settings.learningMemoryEnabled ? 'enabled' : 'disabled') + '.'
          : 'No saved lesson store yet; automatic sharing is disabled until enabled.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'memory',
        'Planning/memory',
        'error',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  checks.push(
    check(
      'screenshot',
      'Screenshot capability',
      process.platform === 'win32' ? 'ok' : 'warning',
      process.platform === 'win32'
        ? 'Available through an explicit user or model request; diagnostics did not capture the desktop.'
        : 'Desktop capture is only supported on the Windows runtime.',
    ),
  );

  try {
    recentAuditEntries = recentAudit(50);
  } catch (error) {
    checks.push(
      check(
        'audit-history',
        'Audit history',
        'warning',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const failedAudit = recentAuditEntries.filter((entry) => !entry.ok);
  recentFailures.push(...failedAudit.slice(0, 10).map(failureFromAudit));

  const runtimeErrors = readJsonlTail('runtime-errors.jsonl', 20);
  for (const record of runtimeErrors.slice(-10)) {
    recentFailures.push({
      source: 'runtime',
      label: boundedDiagnosticText(record.kind, MAX_DIAGNOSTIC_FAILURE_LABEL_CHARS, 'runtime error'),
      detail: boundedDiagnosticText(record.message, 280, 'No error message.'),
      at: (() => {
        const at = numberValue(record.at);
        return at !== undefined && at >= 0 ? at : checkedAt;
      })(),
    });
  }
  recentFailures.sort((a, b) => b.at - a.at);
  checks.push(
    check(
      'recent-errors',
      'Recent errors',
      recentFailures.length ? 'warning' : 'ok',
      recentFailures.length
        ? recentFailures.length + ' recent failed operation or runtime error record(s).'
        : 'No recent failed operation or runtime error records.',
    ),
  );

  const durations = recentAuditEntries
    .map((entry) => entry.durationMs)
    .map(boundedDiagnosticDuration)
    .filter((value): value is number => value !== undefined);
  const modelRequests = readJsonlTail('model-requests.jsonl', 50);
  const averageToolMs = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : undefined;
  const slowestToolMs = durations.length ? Math.max(...durations) : undefined;
  checks.push(
    check(
      'performance',
      'Recent performance',
      slowestToolMs !== undefined && slowestToolMs > 30_000 ? 'warning' : 'ok',
      durations.length
        ? 'Average tool time ' +
            averageToolMs +
            'ms; slowest ' +
            slowestToolMs +
            'ms across ' +
            durations.length +
            ' recent entries.'
        : 'No timed tool entries yet.',
    ),
  );

  const dependencyIssues = checks.filter((item) => item.status === 'error').length;
  checks.push(
    check(
      'dependencies',
      'Dependency issues',
      dependencyIssues ? 'warning' : 'ok',
      dependencyIssues
        ? dependencyIssues + ' diagnostic check(s) failed; inspect the corresponding rows.'
        : 'No blocking dependency issues were found.',
    ),
  );

  return {
    checkedAt,
    checks,
    recentFailures: recentFailures.slice(0, 12),
    metrics: {
      recentAuditEntries: recentAuditEntries.length,
      recentRuntimeErrors: runtimeErrors.length,
      recentModelRequests: modelRequests.length,
      averageToolMs,
      slowestToolMs,
    },
  };
}
