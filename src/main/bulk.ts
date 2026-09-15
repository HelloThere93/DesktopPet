import { isOperationCancellation } from './abort';

export type BulkItemStatus = 'completed' | 'failed' | 'skipped';
export type BulkRunStatus = 'completed' | 'completed-with-errors' | 'cancelled';

export class BulkPartialFailure extends Error {
  constructor(public readonly summary: string) {
    super(summary);
    this.name = 'BulkPartialFailure';
  }
}

export interface BulkProgress {
  status: 'running' | 'completed' | 'cancelled';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  remaining: number;
}

export interface BulkItemResult<T, R> {
  index: number;
  item: T;
  status: BulkItemStatus;
  output?: R;
  error?: string;
}

export interface BulkResult<T, R> extends Omit<BulkProgress, 'status'> {
  status: BulkRunStatus;
  results: BulkItemResult<T, R>[];
}

export interface BulkRunOptions {
  signal?: AbortSignal;
  maxItems?: number;
  onProgress?: (progress: BulkProgress) => void;
}

function isCancellation(error: unknown): boolean {
  return isOperationCancellation(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progressOf(
  status: BulkProgress['status'],
  total: number,
  completed: number,
  failed: number,
  skipped: number,
): BulkProgress {
  return {
    status,
    total,
    completed,
    failed,
    skipped,
    remaining: Math.max(0, total - completed - failed - skipped),
  };
}

function report(progress: BulkProgress, callback?: (progress: BulkProgress) => void): void {
  if (!callback) return;
  try {
    callback(progress);
  } catch {
    // Progress listeners are observers. A broken UI listener must not break
    // the operation being observed.
  }
}

/**
 * Runs independent items serially with bounded input, cancellation, progress,
 * and failure isolation. It deliberately does not retry: callers know the
 * operation's idempotency and can decide whether a retry is safe.
 */
export async function runBulk<T, R>(
  items: readonly T[],
  execute: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: BulkRunOptions = {},
): Promise<BulkResult<T, R>> {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 100));
  if (items.length > maxItems) {
    throw new Error('Bulk operation contains ' + items.length + ' items; the limit is ' + maxItems + '.');
  }

  const results: BulkItemResult<T, R>[] = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  report(progressOf('running', items.length, completed, failed, skipped), options.onProgress);

  for (const [index, item] of items.entries()) {
    if (options.signal?.aborted) {
      const remaining = items.length - index;
      for (const [offset, remainingItem] of items.slice(index).entries()) {
        results.push({
          index: index + offset,
          item: remainingItem,
          status: 'skipped',
          error: 'Cancelled before execution.',
        });
      }
      skipped += remaining;
      break;
    }
    try {
      const output = await execute(item, index, options.signal);
      results.push({ index, item, status: 'completed', output });
      completed += 1;
    } catch (error) {
      if (options.signal?.aborted || isCancellation(error)) {
        results.push({
          index,
          item,
          status: 'skipped',
          error: 'Cancelled during execution.',
        });
        skipped += 1;
        const remaining = items.length - index - 1;
        for (const [offset, remainingItem] of items.slice(index + 1).entries()) {
          results.push({
            index: index + 1 + offset,
            item: remainingItem,
            status: 'skipped',
            error: 'Cancelled before execution.',
          });
        }
        skipped += remaining;
        report(progressOf('cancelled', items.length, completed, failed, skipped), options.onProgress);
        return {
          status: 'cancelled',
          total: items.length,
          completed,
          failed,
          skipped,
          remaining: 0,
          results,
        };
      }

      results.push({ index, item, status: 'failed', error: errorText(error) });
      failed += 1;
    }

    report(progressOf('running', items.length, completed, failed, skipped), options.onProgress);
  }

  const status: BulkRunStatus = options.signal?.aborted
    ? 'cancelled'
    : failed
      ? 'completed-with-errors'
      : 'completed';
  report(progressOf(status === 'cancelled' ? 'cancelled' : 'completed', items.length, completed, failed, skipped), options.onProgress);
  return {
    status,
    total: items.length,
    completed,
    failed,
    skipped,
    remaining: Math.max(0, items.length - completed - failed - skipped),
    results,
  };
}

export function boundedStringArray(
  value: unknown,
  label: string,
  options: { maxItems?: number; maxItemLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array of strings.');
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 100));
  if (value.length > maxItems) {
    throw new Error(label + ' contains ' + value.length + ' items; the limit is ' + maxItems + '.');
  }
  const maxItemLength = Math.max(1, Math.floor(options.maxItemLength ?? 20_000));
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(label + '[' + index + '] must be a string.');
    const clean = item.trim();
    if (!clean) throw new Error(label + '[' + index + '] cannot be empty.');
    if (clean.length > maxItemLength) {
      throw new Error(label + '[' + index + '] exceeds the ' + maxItemLength + '-character limit.');
    }
    return clean;
  });
}


export interface BulkPlanItem<T> {
  index: number;
  item: T;
}

export interface BulkPlan<T> {
  total: number;
  selected: BulkPlanItem<T>[];
  selectedCount: number;
  excludedIndices: number[];
  excludedCount: number;
}

export function boundedIndexArray(
  value: unknown,
  label: string,
  options: { maxItems?: number; maxIndex?: number } = {},
): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(label + ' must be an array of positive integers.');
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 100));
  const maxIndex = Math.max(1, Math.floor(options.maxIndex ?? 1_000_000));
  if (value.length > maxItems) {
    throw new Error(label + ' contains ' + value.length + ' items; the limit is ' + maxItems + '.');
  }

  const seen = new Set<number>();
  return value.map((item, index) => {
    if (
      typeof item !== 'number' ||
      !Number.isInteger(item) ||
      item < 1 ||
      item > maxIndex
    ) {
      throw new Error(label + '[' + index + '] must be a positive integer no greater than ' + maxIndex + '.');
    }
    if (seen.has(item)) throw new Error(label + ' contains duplicate index ' + item + '.');
    seen.add(item);
    return item;
  });
}

export function planBulkItems<T>(
  items: readonly T[],
  selection?: readonly number[],
  exclusions?: readonly number[],
): BulkPlan<T> {
  const total = items.length;
  const selectedNumbers = selection === undefined
    ? items.map((_item, index) => index + 1)
    : [...selection];
  const selectedSet = new Set(selectedNumbers);
  const excludedSet = new Set(exclusions ?? []);

  for (const index of [...selectedSet, ...excludedSet]) {
    if (index < 1 || index > total) {
      throw new Error(
        'Bulk selection index ' +
          index +
          ' must be a positive integer; it is outside the 1-' +
          total +
          ' range.',
      );
    }
  }

  const selected: BulkPlanItem<T>[] = [];
  for (const [index, item] of items.entries()) {
    const oneBased = index + 1;
    if (selectedSet.has(oneBased) && !excludedSet.has(oneBased)) {
      selected.push({ index, item });
    }
  }

  const excludedIndices = [...excludedSet]
    .filter((index) => selectedSet.has(index))
    .sort((a, b) => a - b);
  return {
    total,
    selected,
    selectedCount: selected.length,
    excludedIndices,
    excludedCount: excludedIndices.length,
  };
}

export function formatBulkPlan<T>(
  plan: BulkPlan<T>,
  describeItem: (item: T) => string,
  maxCharacters = 12_000,
): string {
  const lines = [
    'Bulk preview. ' +
      plan.selectedCount +
      ' of ' +
      plan.total +
      ' item(s) selected; ' +
      plan.excludedCount +
      ' excluded.',
  ];
  for (const entry of plan.selected) {
    lines.push('--- [' + (entry.index + 1) + '] ' + truncate(describeItem(entry.item), 2_000));
  }
  if (plan.excludedIndices.length) {
    lines.push('Excluded indices: ' + plan.excludedIndices.join(', ') + '.');
  }
  return truncate(lines.join('\n'), maxCharacters);
}


export function normalizeBulkArguments(
  name: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...rawArgs };
  switch (name) {
    case 'run_batch':
      args.commands = boundedStringArray(rawArgs.commands, 'commands', { maxItems: 40, maxItemLength: 20_000 });
      args.selection = boundedIndexArray(rawArgs.selection, 'selection', { maxItems: 40, maxIndex: 40 });
      args.exclude = boundedIndexArray(rawArgs.exclude, 'exclude', { maxItems: 40, maxIndex: 40 });
      break;
    case 'research':
      args.queries = boundedStringArray(rawArgs.queries, 'queries', { maxItems: 4, maxItemLength: 2_000 });
      break;
    case 'web_search_bulk':
      args.queries = boundedStringArray(rawArgs.queries, 'queries', { maxItems: 6, maxItemLength: 2_000 });
      break;
    case 'fetch_url_bulk':
      args.urls = boundedStringArray(rawArgs.urls, 'urls', { maxItems: 8, maxItemLength: 4_000 });
      break;
    case 'read_many_files':
      args.paths = boundedStringArray(rawArgs.paths, 'paths', { maxItems: 20, maxItemLength: 4_000 });
      break;
  }
  return args;
}

function truncate(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  return text.slice(0, Math.max(0, maxCharacters - 28)) + '\n...[bulk output truncated]';
}

/** Formats a bounded, model-readable result without exposing implementation objects. */
export function formatBulkResult<T, R>(
  result: BulkResult<T, R>,
  describeItem: (item: T) => string,
  describeOutput: (output: R) => string = (output) => String(output),
  maxCharacters = 30_000,
): string {
  const heading =
    'Bulk operation ' +
    result.status +
    '. Progress: ' +
    result.completed +
    ' completed, ' +
    result.failed +
    ' failed, ' +
    result.skipped +
    ' skipped, ' +
    result.remaining +
    ' remaining of ' +
    result.total +
    '.';
  const lines = [heading];
  for (const entry of result.results) {
    const item = describeItem(entry.item);
    if (entry.status === 'completed') {
      lines.push(
        '--- [' +
          (entry.index + 1) +
          '/' +
          result.total +
          '] ' +
          item +
          '\n' +
          truncate(describeOutput(entry.output as R), 5_000),
      );
    } else {
      lines.push(
        '--- [' +
          (entry.index + 1) +
          '/' +
          result.total +
          '] ' +
          entry.status.toUpperCase() +
          ': ' +
          item +
          (entry.error ? '\n' + truncate(entry.error, 1_000) : ''),
      );
    }
  }
  return truncate(lines.join('\n\n'), maxCharacters);
}
