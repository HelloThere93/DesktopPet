/**
 * Small, process-local notification gate.
 *
 * Notifications are intentionally ephemeral: the gate does not persist their
 * contents, but it remembers bounded keys long enough to collapse repeated
 * background events into one useful signal.
 */

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

export interface NotificationDecision {
  show: boolean;
  key: string;
  cooldownMs: number;
  suppressedForMs?: number;
}

const DEFAULT_COOLDOWNS: Record<NotificationPriority, number> = {
  low: 10 * 60_000,
  normal: 2 * 60_000,
  high: 30_000,
  critical: 0,
};

const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

export function normalizeNotificationPriority(value: string): NotificationPriority {
  const clean = value.trim().toLowerCase();
  return clean === 'low' || clean === 'high' || clean === 'critical' ? clean : 'normal';
}

export function notificationCooldownMs(priority: string, cooldownSeconds?: number): number {
  if (cooldownSeconds !== undefined && Number.isFinite(cooldownSeconds)) {
    return Math.min(Math.max(cooldownSeconds, 0), MAX_COOLDOWN_SECONDS) * 1000;
  }
  return DEFAULT_COOLDOWNS[normalizeNotificationPriority(priority)];
}

export function notificationKey(title: string, body: string): string {
  return (title + '\n' + body).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 900);
}

export class NotificationGate {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly maxEntries = 256,
  ) {}

  decide(
    title: string,
    body: string,
    priority: string = 'normal',
    cooldownSeconds?: number,
  ): NotificationDecision {
    const key = notificationKey(title, body);
    const cooldownMs = notificationCooldownMs(priority, cooldownSeconds);
    const now = this.clock();
    const previous = this.recent.get(key);

    if (previous !== undefined && cooldownMs > 0 && now >= previous && now - previous < cooldownMs) {
      return {
        show: false,
        key,
        cooldownMs,
        suppressedForMs: cooldownMs - (now - previous),
      };
    }

    this.recent.delete(key);
    this.recent.set(key, now);
    while (this.recent.size > Math.max(1, this.maxEntries)) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }

    return { show: true, key, cooldownMs };
  }
}
