import { app } from 'electron';
import { join } from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from '../durable-store';
import { logRuntimeError } from '../observability';
import { notify as showNotification } from './system';

/**
 * Timers the pet keeps for you.
 *
 * Kept in a JSON file rather than in memory, so a reminder set before lunch
 * still fires after a restart — the common case for anything more than a few
 * minutes out. Anything whose moment passed while the app was closed fires once
 * at startup, late but visible, rather than disappearing silently.
 */

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
}
export const MAX_REMINDERS = 500;
export const MAX_REMINDER_ID_CHARS = 100;
export const MAX_REMINDER_TEXT_CHARS = 2_000;
export const MAX_REMINDER_OUTPUT_CHARS = 40_000;
const MAX_REMINDER_DATE_MS = 8_640_000_000_000_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let remindersPaused = false;

function clearTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReminderTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REMINDER_DATE_MS;
}

function isReminder(value: unknown): value is Reminder {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= MAX_REMINDER_ID_CHARS &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= MAX_REMINDER_TEXT_CHARS &&
    isReminderTimestamp(value.dueAt) &&
    isReminderTimestamp(value.createdAt)
  );
}

function isReminderList(value: unknown): value is Reminder[] {
  return Array.isArray(value) && value.length <= MAX_REMINDERS && value.every(isReminder);
}

function storePath(): string {
  return join(app.getPath('userData'), 'reminders.json');
}

function load(): Reminder[] {
  return readJsonFile<Reminder[]>(storePath(), [], isReminderList);
}

function save(list: Reminder[]): void {
  writeJsonFileAtomic(storePath(), list);
}

const REMINDER_RETRY_DELAY_MS = 1_000;

function scheduleRetry(r: Reminder): void {
  const previous = timers.get(r.id);
  if (previous) clearTimeout(previous);
  timers.set(r.id, setTimeout(() => fire(r, false), REMINDER_RETRY_DELAY_MS));
}

function fire(r: Reminder, late: boolean): void {
  if (remindersPaused) {
    timers.delete(r.id);
    return;
  }
  try {
    const current = load();
    if (!current.some((x) => x.id === r.id)) {
      timers.delete(r.id);
      return;
    }
    save(current.filter((x) => x.id !== r.id));
  } catch (error) {
    logRuntimeError('integration-error', error);
    scheduleRetry(r);
    return;
  }

  timers.delete(r.id);
  try {
    showNotification(
      late ? 'Reminder (while you were away)' : 'Reminder',
      r.text,
      'high',
    );
  } catch (error) {
    logRuntimeError('integration-error', error);
  }
}

/** setTimeout overflows past ~24.8 days, so long waits are re-armed in stages. */
const MAX_DELAY = 2_000_000_000;

function arm(r: Reminder): void {
  if (remindersPaused) return;
  const wait = r.dueAt - Date.now();
  if (wait <= 0) {
    fire(r, true);
    return;
  }
  timers.set(
    r.id,
    setTimeout(() => (Date.now() >= r.dueAt ? fire(r, false) : arm(r)), Math.min(wait, MAX_DELAY)),
  );
}

/** Called once at startup to re-arm everything that survived the restart. */
export function restoreReminders(): void {
  clearTimers();
  if (remindersPaused) return;

  let list: Reminder[];
  try {
    list = load();
  } catch (error) {
    logRuntimeError('integration-error', error);
    return;
  }
  for (const r of list) arm(r);
}

/** Pauses delivery without deleting reminders; resuming re-arms overdue entries safely. */
export function setRemindersPaused(next: boolean): void {
  remindersPaused = next;
  if (next) {
    clearTimers();
    return;
  }
  restoreReminders();
}

/**
 * @param when  Minutes from now, or an absolute time like "17:30" or
 *              "2026-08-20 09:00".
 */
export function setReminder(text: string, when: string): string {
  if (typeof text !== 'string' || typeof when !== 'string') throw new Error('Reminder text and time must be text.');
  const clean = text.trim();
  if (!clean) throw new Error('A reminder needs something to say.');
  if (clean.length > MAX_REMINDER_TEXT_CHARS) throw new Error('Reminder text is too long.');

  const dueAt = parseWhen(when);
  if (!Number.isFinite(dueAt)) {
    throw new Error(`Could not read "${when}" as a time. Use minutes ("25"), "17:30", or "2026-08-20 09:00".`);
  }
  if (dueAt <= Date.now()) throw new Error('That time has already passed.');
  const existing = load();
  if (existing.length >= MAX_REMINDERS) throw new Error('The reminder list is full.');

  const r: Reminder = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    dueAt,
    createdAt: Date.now(),
  };
  save([...existing, r]);
  arm(r);

  const mins = Math.round((dueAt - Date.now()) / 60000);
  return `Reminder ${r.id} set for ${new Date(dueAt).toLocaleString()} (in ${mins} minute${mins === 1 ? '' : 's'}).`;
}

function parseWhen(when: string): number {
  const raw = when.trim();

  // Bare number, or "20m" / "2h" — a duration from now.
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hours?|s|sec|seconds?)?$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 'm').toLowerCase();
    const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('h') ? n * 3_600_000 : n * 60_000;
    return Date.now() + ms;
  }

  // A clock time today, rolling to tomorrow if it has already gone.
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const d = new Date();
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? NaN : parsed;
}

export function reminderCount(): number {
  return load().length;
}

export function listReminders(): string {
  const list = load().sort((a, b) => a.dueAt - b.dueAt);
  if (!list.length) return '(no reminders set)';
  const output = list
    .map((r) => {
      const mins = Math.round((r.dueAt - Date.now()) / 60000);
      return `${r.id}  ${new Date(r.dueAt).toLocaleString()}  (in ${mins}m)  ${r.text}`;
    })
    .join('\n');
  if (output.length <= MAX_REMINDER_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_REMINDER_OUTPUT_CHARS - 24) + '\n…[reminders truncated]';
}

export function cancelReminder(id: string): string {
  const list = load();
  if (typeof id !== 'string' || id.length > MAX_REMINDER_ID_CHARS) throw new Error('Invalid reminder id.');
  const found = list.find((r) => r.id === id);
  if (!found) throw new Error(`No reminder with id ${id}.`);
  save(list.filter((r) => r.id !== id));
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  return `Cancelled: ${found.text}`;
}
