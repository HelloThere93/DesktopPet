const MAX_RECOVERY_SOURCE_CHARS = 4_000;

/**
 * Returns safe, user-facing next-step guidance for known browser recovery
 * boundaries. It intentionally never offers to replay a browser mutation.
 */
export function browserRecoveryGuidance(value: unknown): string | undefined {
  const source =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : '';
  const text = source.slice(0, MAX_RECOVERY_SOURCE_CHARS).toLowerCase();
  if (text.includes('chrome target became unavailable')) {
    return 'Chrome lost the tab connection. Check the page before asking Adi to retry; clicks and typing are not replayed automatically.';
  }
  if (text.includes('chrome_needs_restart') || text.includes('running chrome cannot have')) {
    return 'Chrome is open without automation. Let Adi call the one-time restart tool and approve the prompt; connected or recently restarted sessions are left open.';
  }
  if (text.includes('chrome was reopened without automation')) {
    return 'Chrome reopened safely without automation and is not connected. Let Adi retry the browser action first; another restart is not attempted immediately.';
  }
  return undefined;
}