import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { ApprovalMode, PermissionTier } from '../shared/types';
import { isAllowlisted } from './db';
import { findCustomTool, type CustomTool } from './tools/custom';
import { sensitiveDecisionFor } from './read-safety';

export interface Classification {
  tier: PermissionTier;
  reason: string;
  /** Stable identity for allowlisting. Undefined => never allowlistable. */
  signature?: string;
  /** Cannot become a saved/session grant; Full auto still honors the user's global opt-in. */
  requiresExplicitConfirmation?: boolean;
  /** May cover the same tool and exact browser tab for this request only. */
  taskApprovalAllowed?: boolean;
}

/**
 * Patterns that are refused outright, with no user override path.
 *
 * The bar for this list: actions that destroy data irrecoverably, disable the
 * machine's defenses, or exfiltrate credentials. A confirmation prompt is not
 * adequate protection for these, because the whole point of a prompt is that a
 * user under time pressure clicks yes.
 */
const DENY_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\bformat(\.com)?\b\s+[a-z]:/i, why: 'formats a drive' },
  { re: /\b(diskpart|clean\s+all)\b/i, why: 'low-level disk partitioning' },
  { re: /\bvssadmin\b.*\bdelete\b.*\bshadows\b/i, why: 'destroys shadow copies (ransomware pattern)' },
  { re: /\bwbadmin\b.*\bdelete\b/i, why: 'deletes system backups' },
  { re: /\bbcdedit\b.*\b(recoveryenabled|bootstatuspolicy)\b/i, why: 'disables Windows recovery' },
  { re: /\bcipher\b\s*\/w/i, why: 'wipes free space irrecoverably' },
  // Credential and secrets access.
  { re: /HK(LM|EY_LOCAL_MACHINE)\\+(SAM|SECURITY)\b/i, why: 'reads the credential hives' },
  { re: /\breg\b.*\bsave\b.*\b(sam|security|system)\b/i, why: 'dumps credential hives' },
  { re: /\b(mimikatz|lsass|sekurlsa)\b/i, why: 'credential dumping' },
  { re: /\bvaultcmd\b|\bcmdkey\b\s*\/list/i, why: 'reads the Windows credential vault' },
  { re: /Get-Credential|ConvertFrom-SecureString/i, why: 'extracts stored credentials' },
  // Defense evasion.
  { re: /Set-MpPreference|Add-MpPreference.*Exclusion|\bMpCmdRun\b/i, why: 'alters Windows Defender' },
  { re: /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i, why: 'disables PowerShell script protections' },
  { re: /\bnetsh\b.*\bfirewall\b.*\b(off|disable)\b/i, why: 'disables the firewall' },
  { re: /\bbcdedit\b.*\btestsigning\b.*\bon\b/i, why: 'disables driver signature enforcement' },
  // Mass destruction.
  { re: /Remove-Item.*-Recurse.*(-Force)?.*\b[a-z]:\\?(\*|\s*$|windows|users)\b/i, why: 'mass recursive delete of a system path' },
  { re: /\b(rd|rmdir)\b\s+\/s.*\b[a-z]:\\?(\*|windows|users)\b/i, why: 'mass recursive delete of a system path' },
  { re: /\bdel\b\s+\/[fsq]*\s+[a-z]:\\\*/i, why: 'mass delete from a drive root' },
  // Remote code execution — fetching and running unreviewed code.
  { re: /(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)[^|]*\|\s*(iex|Invoke-Expression|bash|sh|powershell)/i, why: 'pipes downloaded code straight into a shell' },
  { re: /\bDownloadString\b.*\bIEX\b|\bIEX\b.*\bDownloadString\b/i, why: 'executes downloaded code' },
  // Account manipulation.
  { re: /\bnet\b\s+(user|localgroup)\b.*\/(add|delete)/i, why: 'creates or deletes user accounts' },
];

/**
 * Paths no file operation may touch destructively.
 *
 * The command patterns above catch `Remove-Item -Recurse C:\Windows`, but the
 * file tools take a bare path argument, where there is no command string to
 * match — so deleting the same folder through delete_item would only have asked
 * for confirmation. A prompt is not protection against destroying the OS.
 */
const SEP = '[\\\\/]';

const PROTECTED_PATHS: { re: RegExp; why: string }[] = [
  { re: new RegExp(`^[a-z]:${SEP}?$`, 'i'), why: 'is a drive root' },
  { re: new RegExp(`^[a-z]:${SEP}windows(?![a-z0-9])`, 'i'), why: 'is inside the Windows directory' },
  {
    re: new RegExp(`^[a-z]:${SEP}program files( \\(x86\\))?(?![a-z0-9])`, 'i'),
    why: 'is inside Program Files',
  },
  { re: new RegExp(`^[a-z]:${SEP}programdata(?![a-z0-9])`, 'i'), why: 'is inside ProgramData' },
  { re: new RegExp(`(?:^|${SEP})(?:system32|syswow64)(?:${SEP}|$)`, 'i'), why: 'is a system directory' },
  { re: new RegExp(`${SEP}config${SEP}(sam|security|system|software)$`, 'i'), why: 'is a registry hive file' },
  // Registry paths reach these tools as strings too.
  { re: /^HK(LM|EY_LOCAL_MACHINE|CU|EY_CURRENT_USER)/i, why: 'is a registry key, not a file' },
  // The profile root itself; folders inside it are ordinary user data.
  {
    re: new RegExp(`^[a-z]:${SEP}users${SEP}[^\\\\/]+${SEP}?$`, 'i'),
    why: 'is an entire user profile',
  },
  { re: new RegExp(`^[a-z]:${SEP}users${SEP}?$`, 'i'), why: 'is the Users directory' },
];

/** Why a path must never be modified, or null when it is ordinary. */
export function protectedPathReason(path: string): string | null {
  const raw = path.trim().replace(/["']/g, '');
  if (!raw) return null;

  const withoutExtendedPrefix = raw.replace(/^\\\\\?\\/, '');
  const candidates = new Set([raw, withoutExtendedPrefix, win32.resolve(withoutExtendedPrefix)]);
  for (const candidate of candidates) {
    for (const { re, why } of PROTECTED_PATHS) {
      if (re.test(candidate)) return why;
    }
  }
  for (const candidate of candidates) {
    const why = denyCheck(candidate);
    if (why) return why;
  }
  return null;
}

/** Registry roots that are read-only no matter what. */
const REGISTRY_WRITE_DENY = /^HK(LM|EY_LOCAL_MACHINE)\\+(SAM|SECURITY|SYSTEM\\+CurrentControlSet\\+Services)/i;

/**
 * Read-only shell verbs. Anything not matching runs through confirmation —
 * the list is deliberately an allowlist, not a denylist, because guessing
 * which unknown command is safe is exactly the wrong default.
 */
const READONLY_SHELL = [
  /^Get-(Process|Service|ChildItem|Content|Location|Date|ComputerInfo|Host|Item|ItemProperty|Volume|Disk|NetIPAddress|NetAdapter|CimInstance|WmiObject|Command|Module|Random|TimeZone|Culture|Clipboard)\b/i,
  /^(dir|ls|type|cat|echo|whoami|hostname|date|time|ver|pwd|where|which|tree|systeminfo|ipconfig|tasklist)\b/i,
  /^set(?:\s|$)/i,
  /^(Test-Path|Measure-Object|Select-String|Resolve-Path|Split-Path|Join-Path|ConvertTo-Json|ConvertFrom-Json|Out-String|Format-(List|Table))\b/i,
];

// A read-only verb is not safe when its arguments can introduce another
// command, redirect output, or evaluate a nested PowerShell expression.
// This intentionally over-classifies quoted punctuation as confirmation; the
// classifier must never turn uncertain shell syntax into automatic approval.
const SHELL_CONTROL_SYNTAX = /[;&<>\r\n]|\|\||\$\s*\(|@\s*\(/;

function isReadonlyShell(command: string): boolean {
  const trimmed = command.trim();
  if (SHELL_CONTROL_SYNTAX.test(trimmed)) return false;
  // A pipeline is only read-only if every stage is. Splitting on | is crude but
  // errs toward confirmation, which is the safe direction.
  const stages = trimmed.split('|').map((s) => s.trim()).filter(Boolean);
  if (!stages.length) return false;
  return stages.every((stage) => READONLY_SHELL.some((re) => re.test(stage)));
}

/**
 * Identity of a command for allowlist purposes.
 *
 * Normalization is deliberately limited to whitespace and case. It is tempting
 * to collapse literals into placeholders so that approving `Get-Process chrome`
 * also covers `Get-Process notepad` — but the same generalization would make an
 * approval of `Remove-Item "C:\tmp\scratch.txt"` silently cover
 * `Remove-Item "C:\Windows\System32\..."`, since the arguments are precisely
 * what decides whether the command is safe. "Always allow" therefore means this
 * exact command, and a changed argument prompts again.
 */
export function signatureFor(toolName: string, command: string): string {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${toolName}\u0000${normalized}`).digest('hex').slice(0, 32);
}

function browserTaskReadGrant(
  args: Record<string, unknown>,
): Pick<Classification, 'signature' | 'taskApprovalAllowed'> | Record<string, never> {
  const tabId = String(args.tabId ?? '').trim();
  if (!tabId || tabId.length > 240) return {};
  return {
    signature: signatureFor('request:browser-tab-read', tabId),
    taskApprovalAllowed: true,
  };
}

const MAX_SESSION_APPROVALS = 256;
const sessionAllowlist = new Set<string>();

/** Session approvals are memory-only and disappear when the app exits. */
export function isSessionAllowlisted(signature: string): boolean {
  return sessionAllowlist.has(signature);
}

export function addToSessionAllowlist(signature: string): void {
  const clean = signature.trim();
  if (!clean) return;
  if (sessionAllowlist.size >= MAX_SESSION_APPROVALS && !sessionAllowlist.has(clean)) {
    const oldest = sessionAllowlist.values().next().value;
    if (typeof oldest === 'string') sessionAllowlist.delete(oldest);
  }
  sessionAllowlist.add(clean);
}

export function clearSessionAllowlist(): void {
  sessionAllowlist.clear();
}

const MAX_TASK_APPROVAL_OPERATIONS = 32;
const MAX_TASK_APPROVALS_PER_OPERATION = 16;
const TASK_APPROVAL_TTL_MS = 30 * 60_000;
const taskAllowlists = new Map<string, { signatures: Set<string>; touchedAt: number }>();

function pruneTaskAllowlists(now = Date.now()): void {
  for (const [operationId, bucket] of taskAllowlists) {
    if (now - bucket.touchedAt > TASK_APPROVAL_TTL_MS) taskAllowlists.delete(operationId);
  }
  while (taskAllowlists.size > MAX_TASK_APPROVAL_OPERATIONS) {
    const oldest = taskAllowlists.keys().next().value;
    if (typeof oldest !== 'string') break;
    taskAllowlists.delete(oldest);
  }
}

export function isTaskAllowlisted(operationId: string, signature: string): boolean {
  const operation = operationId.trim();
  const clean = signature.trim();
  if (!operation || !clean) return false;
  const now = Date.now();
  pruneTaskAllowlists(now);
  const bucket = taskAllowlists.get(operation);
  if (!bucket?.signatures.has(clean)) return false;
  // Keep an actively used request grant alive for long-running agent turns.
  // The turn lifecycle still clears it immediately when the request settles.
  bucket.touchedAt = now;
  return true;
}

export function addToTaskAllowlist(operationId: string, signature: string): void {
  const operation = operationId.trim();
  const clean = signature.trim();
  if (!operation || !clean) return;
  pruneTaskAllowlists();
  let bucket = taskAllowlists.get(operation);
  if (!bucket) {
    bucket = { signatures: new Set<string>(), touchedAt: Date.now() };
    taskAllowlists.set(operation, bucket);
  }
  if (bucket.signatures.size >= MAX_TASK_APPROVALS_PER_OPERATION && !bucket.signatures.has(clean)) return;
  bucket.signatures.add(clean);
  bucket.touchedAt = Date.now();
}

export function clearTaskAllowlist(operationId?: string): void {
  if (operationId) taskAllowlists.delete(operationId.trim());
  else taskAllowlists.clear();
}

export function taskApprovalAllowed(c: Classification): boolean {
  return c.tier === 'confirm' && c.taskApprovalAllowed === true && !!c.signature;
}

export function sessionApprovalAllowed(c: Classification): boolean {
  return c.tier === 'confirm' && !!c.signature && !c.requiresExplicitConfirmation;
}

function denyCheck(text: string): string | null {
  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(text)) return why;
  }
  return null;
}

function shellDenyCheck(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'run_powershell' || toolName === 'run_cmd') {
    return denyCheck(String(args.command ?? ''));
  }
  if (toolName === 'run_batch' && Array.isArray(args.commands)) {
    for (const command of args.commands) {
      const why = denyCheck(String(command ?? ''));
      if (why) return why;
    }
  }
  return null;
}

/** Classify a tool invocation into a permission tier. */
export function classify(toolName: string, args: Record<string, unknown>, dynamicTool?: CustomTool | null): Classification {
  // Never-tier shell patterns must win before sensitive-read classification;
  // otherwise a command mentioning a secret-shaped path could be downgraded
  // from an unconditional refusal to an ordinary confirmation.
  const shellWhy = shellDenyCheck(toolName, args);
  if (shellWhy) return { tier: 'never', reason: `Blocked: ${shellWhy}.` };
  const sensitive = sensitiveDecisionFor(toolName, args);
  if (sensitive) {
    return { ...sensitive, requiresExplicitConfirmation: sensitive.tier === 'confirm' };
  }
  switch (toolName) {
    /* -------------------------------------------------- read-only tools */
    case 'chrome_list_tabs':
      return {
        tier: 'confirm',
        reason: 'Reads browser tab metadata and sends it to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'chrome_tabs_context':
      return {
        tier: 'confirm',
        reason: 'Reads bounded page content from several already-open browser tabs and sends it to the model.',
        signature: signatureFor('request:browser-tabs-read', 'open-tabs'),
        taskApprovalAllowed: true,
        requiresExplicitConfirmation: true,
      };
    case 'chrome_read_tab':
    case 'chrome_snapshot':
    case 'chrome_page_context':
    case 'chrome_wait_for_text':
      return {
        tier: 'confirm',
        reason: 'Reads browser page content and sends it to the model.',
        ...browserTaskReadGrant(args),
        requiresExplicitConfirmation: true,
      };

    case 'chrome_screenshot':
      return {
        tier: 'confirm',
        reason: 'Captures a browser window and sends its visual contents to the model.',
        ...browserTaskReadGrant(args),
        requiresExplicitConfirmation: true,
      };
    case 'chrome_list_profiles':
      return {
        tier: 'confirm',
        reason: 'Reads browser profile names and signed-in account metadata.',
        requiresExplicitConfirmation: true,
      };

    case 'chrome_close_tabs':
      return {
        tier: 'confirm',
        reason: 'Closes tabs in a browser profile.',
        requiresExplicitConfirmation: true,
      };

    case 'chrome_element_html':
    case 'chrome_tables':
    case 'chrome_links':
      return {
        tier: 'confirm',
        reason: 'Reads structured content from a browser page and sends it to the model.',
        ...browserTaskReadGrant(args),
        requiresExplicitConfirmation: true,
      };

    case 'read_file': {
      const path = String(args.path ?? '');
      const why = denyCheck(path);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return { tier: 'auto', reason: 'Reads a file without modifying it.' };
    }

    case 'list_dir':
      return { tier: 'auto', reason: 'Lists directory contents.' };

    case 'search_files':
    case 'search_text':
    case 'file_info':
    case 'list_processes':
    case 'list_windows':
    case 'read_clipboard':
    case 'fetch_url':
    case 'web_search':
    case 'research':
    case 'web_search_bulk':
    case 'fetch_url_bulk':
    case 'list_tools':
    case 'find_tools':
    case 'list_screens':
    case 'read_lines':
    case 'read_files':
    case 'read_document':
    case 'system_info':
    case 'disk_usage':
    case 'network_info':
    case 'list_services':
    case 'list_startup_apps':
    case 'installed_apps':
    case 'list_scheduled_tasks':
    case 'battery_status':
    case 'get_volume':
    case 'cursor_position':
    case 'env_vars':
    case 'winget_search':
    case 'chrome_wait_for':
    case 'mcp_servers':
    case 'list_window_bounds':
    case 'window_bounds':
    case 'active_window':
    case 'image_info':
    case 'hash_file':
    case 'diff_files':
    case 'read_csv':
    case 'json_query':
    case 'regex_extract':
    case 'file_tree':
    case 'dir_size':
    case 'recent_files':
    case 'base64_encode':
    case 'base64_decode':
    case 'current_time':
    case 'cpu_usage':
    case 'memory_usage':
    case 'gpu_status':
    case 'event_log':
    case 'ping_host':
    case 'dns_lookup':
    case 'port_check':
    case 'network_connections':
    case 'public_ip':
    case 'list_devices':
    case 'list_printers':
    case 'defender_status':
    case 'windows_update_status':
    case 'list_recycle_bin':
    case 'git_status':
    case 'git_log':
    case 'git_diff':
    case 'git_branches':
      return { tier: 'auto', reason: 'Reads local configuration without changing anything.' };

    case 'wait':
    case 'wait_for_window':
      return { tier: 'auto', reason: 'Looks at the screen or pauses. Changes nothing.' };

    case 'pixel_color':
    case 'find_on_screen':
    case 'read_screen_text':
    case 'capture_window':
      return {
        tier: 'confirm',
        reason: 'Reads visual or text content from your screen and sends it to the model.',
        requiresExplicitConfirmation: true,
      };

    case 'read_pdf': {
      const why = denyCheck(String(args.path ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return { tier: 'auto', reason: 'Reads a PDF without modifying it.' };
    }

    case 'paste_text':
    case 'clear_and_type':
    case 'key_combo':
      // Same standing as type_text: it goes wherever the caret is, and no
      // signature, because approving one string is not approving the next.
      return {
        tier: 'confirm',
        reason:
          'Sends real keyboard input to whatever is in front. It cannot see what moved since its last look.',
      };

    case 'input_sequence':
      // The whole macro is shown before any of it runs. Never remembered: a
      // sequence is a small program, and the next one is a different program.
      return {
        tier: 'confirm',
        reason: 'Runs a whole sequence of clicks and keystrokes. Read the steps before allowing.',
      };

    case 'open_app': {
      const why = denyCheck(String(args.name ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Starts a program.',
        signature: signatureFor('open_app', String(args.name ?? '')),
      };
    }

    case 'close_app':
      return {
        tier: 'confirm',
        reason: args.force
          ? 'Forces a program to stop. Anything unsaved in it is lost.'
          : 'Asks a program to close. It can still prompt about unsaved work.',
        signature: args.force
          ? undefined
          : signatureFor('close_app', String(args.name ?? '')),
      };

    case 'view_image':
    case 'ocr_image': {
      const why = denyCheck(String(args.path ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return { tier: 'auto', reason: 'Reads an image file without modifying it.' };
    }

    case 'capture_region':
    case 'clipboard_image':
      return { tier: 'auto', reason: 'Captures what is already on screen or on the clipboard.' };

    case 'speak_text':
    case 'play_sound':
      return { tier: 'auto', reason: 'Makes a sound. Touches nothing else.' };

    case 'move_window':
      return { tier: 'auto', reason: 'Moves a window. Nothing is lost and it can be moved back.' };

    case 'window_state':
      // Everything except closing is cosmetic and instantly reversible.
      // Closing can lose unsaved work, so that one asks.
      return String(args.state).toLowerCase() === 'close'
        ? {
            tier: 'confirm',
            reason: 'Closes a window. If it holds unsaved work, the app will prompt.',
            signature: signatureFor('window_state', `close:${String(args.title ?? '')}`),
          }
        : { tier: 'auto', reason: 'Minimizes, maximizes or focuses a window.' };

    case 'mouse_drag':
    case 'mouse_down':
    case 'mouse_up':
    case 'hold_key':
      // Same reasoning as mouse_click: no signature, because approving a
      // coordinate is not approving an action.
      return {
        tier: 'confirm',
        reason:
          'Sends real mouse or keyboard input to whatever is in front. It cannot see what moved since its last look.',
      };

    case 'resize_image':
    case 'convert_image':
    case 'crop_image': {
      const dest = String(args.destination ?? '');
      const why = protectedPathReason(dest);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Writes a new image file.',
        signature: signatureFor(toolName, dest),
      };
    }

    case 'replace_in_files': {
      const why = protectedPathReason(String(args.root ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      // No signature: this rewrites every matching file under a folder, and the
      // strings are what decide whether that is safe. Each run is read on its own.
      return {
        tier: 'confirm',
        reason: 'Rewrites every matching file under that folder. Check the strings carefully.',
      };
    }

    case 'run_python':
    case 'run_node': {
      const code = String(args.code ?? '');
      const why = denyCheck(code);
      if (why) return { tier: 'never', reason: `Blocked: the script ${why}.` };
      // Arbitrary code, exactly like a shell command — and like create_tool, it
      // is never remembered, because the next script is a different program.
      return {
        tier: 'confirm',
        reason: `Runs a ${toolName === 'run_python' ? 'Python' : 'JavaScript'} script on your machine. Read it before allowing.`,
        requiresExplicitConfirmation: true,
      };
    }

    case 'chrome_history':
    case 'chrome_bookmarks':
      // The user's own browsing, in the profile they chose. It changes nothing,
      // but it is a record of everywhere they have been.
      return {
        tier: 'confirm',
        reason: 'Reads your browsing history and bookmarks.',
        signature: signatureFor(toolName, 'read'),
        requiresExplicitConfirmation: true,
      };

    case 'print_file':
      return {
        tier: 'confirm',
        reason: 'Prints a document, which uses paper and ink.',
        signature: signatureFor('print_file', String(args.printer ?? 'default')),
      };

    case 'restart_explorer':
      return {
        tier: 'confirm',
        reason: 'Restarts Explorer. Open Explorer windows close and the taskbar flickers.',
        signature: signatureFor('restart_explorer', 'restart'),
      };

    case 'flush_dns':
    case 'create_restore_point':
      return {
        tier: 'confirm',
        reason:
          toolName === 'flush_dns'
            ? 'Clears the DNS cache.'
            : 'Creates a System Restore point, which uses disk space.',
        signature: signatureFor(toolName, 'run'),
      };

    case 'restore_from_recycle_bin':
      return {
        tier: 'confirm',
        reason: 'Puts a deleted file back where it came from.',
        signature: signatureFor('restore_from_recycle_bin', String(args.name ?? '')),
      };

    case 'set_wallpaper':
      return {
        tier: 'confirm',
        reason: 'Changes your desktop wallpaper.',
        signature: signatureFor('set_wallpaper', 'change'),
      };

    case 'create_shortcut': {
      const why = protectedPathReason(String(args.shortcutPath ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Creates a shortcut file.',
        signature: signatureFor('create_shortcut', String(args.shortcutPath ?? '')),
      };
    }

    case 'open_with': {
      const why = denyCheck(`${String(args.program ?? '')} ${String(args.path ?? '')}`);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Runs a program against this file.',
        signature: signatureFor('open_with', `${String(args.program ?? '')}|${String(args.path ?? '')}`),
      };
    }

    case 'chrome_set_value':
    case 'chrome_select_option':
    case 'chrome_back':
    case 'chrome_reload':
      return {
        tier: 'confirm',
        reason: 'Interacts with a web page, which can trigger real actions.',
        signature: signatureFor(toolName, String(args.selector ?? 'page')),
      };

    case 'chrome_save_pdf': {
      const why = protectedPathReason(String(args.destination ?? ''));
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Saves the page as a PDF on disk.',
        signature: signatureFor('chrome_save_pdf', String(args.destination ?? '')),
      };
    }

    case 'chrome_upload_file':
      // Never allowlisted: this hands one of the user's files to a website, and
      // which file and which website is the entire question.
      return {
        tier: 'confirm',
        reason: 'Attaches one of your files to a web page, which may then upload it.',
        requiresExplicitConfirmation: true,
      };

    case 'set_reminder':
    case 'cancel_reminder':
      return { tier: 'auto', reason: 'Sets a notification for later. Changes nothing else.' };

    case 'list_reminders':
      return {
        tier: 'confirm',
        reason: 'Reads pending reminder text and schedules from local storage.',
        requiresExplicitConfirmation: true,
      };
    case 'mcp_read_resource':
      return {
        tier: 'confirm',
        reason: 'Reads content from a connected MCP server and sends it to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'mcp_resources':
      return {
        tier: 'confirm',
        reason: 'Reads the names and descriptions of resources exposed by connected MCP servers.',
        requiresExplicitConfirmation: true,
      };
    case 'mcp_reload':
      return { tier: 'confirm', reason: 'Reconnects configured MCP servers and may launch local programs or network connections.', requiresExplicitConfirmation: true };

    /* ------------------------------------------------------- synthetic input */
    case 'mouse_click':
    case 'mouse_move':
    case 'mouse_scroll':
    case 'type_text':
    case 'press_keys':
      // These land on whatever is focused, and the agent is working from a
      // screenshot taken a moment ago. No signature: "always allow clicking at
      // 400, 300" would be an approval of a coordinate, not of an action, and
      // what sits there changes with every window that opens.
      return {
        tier: 'confirm',
        reason:
          'Sends real mouse or keyboard input to whatever is in front. It cannot see what moved since its last look.',
      };

    case 'set_volume':
    case 'set_brightness':
      return {
        tier: 'confirm',
        reason: 'Changes a hardware setting.',
        signature: signatureFor(toolName, 'level'),
      };

    case 'power_action':
      return {
        tier: 'confirm',
        reason:
          String(args.action) === 'lock'
            ? 'Locks this PC. You will need your password to get back in.'
            : 'Puts the machine to sleep or blanks the display.',
        signature: signatureFor('power_action', String(args.action ?? '')),
      };

    case 'service_control':
      return {
        tier: 'confirm',
        reason: 'Starts or stops a Windows service, which can take something else down with it.',
        signature: signatureFor('service_control', `${String(args.name ?? '')}:${String(args.action ?? '')}`),
      };

    case 'set_env_var':
      return {
        tier: 'confirm',
        reason: 'Changes an environment variable for every program you start from now on.',
        signature: signatureFor('set_env_var', `${String(args.scope ?? 'User')}:${String(args.name ?? '')}`),
      };

    case 'winget_install':
      // Installing software is the one place where "yes" means running an
      // installer as you: never remembered, always read.
      return {
        tier: 'confirm',
        reason: 'Installs software on this machine from the Windows package repository.',
      };

    case 'append_file': {
      const path = String(args.path ?? '');
      const why = protectedPathReason(path);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Adds to a file on disk.',
        signature: signatureFor('append_file', path),
      };
    }

    case 'compress':
    case 'extract': {
      const dest = String(args.destination ?? '');
      const why = protectedPathReason(dest);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: toolName === 'compress' ? 'Writes a zip file.' : 'Writes files out of an archive.',
        signature: signatureFor(toolName, dest),
      };
    }

    case 'download_file': {
      const dest = String(args.destination ?? '');
      const why = protectedPathReason(dest);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      // Never allowlisted: the file's contents come from the internet, so
      // approving one download says nothing about the next.
      return {
        tier: 'confirm',
        reason: 'Saves a file from the internet onto your disk.',
      };
    }

    case 'http_request': {
      const method = String(args.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        return { tier: 'auto', reason: 'Reads from a URL without sending a request body.' };
      }
      // A POST is an action taken somewhere else, and cannot be recalled.
      return {
        tier: 'confirm',
        reason: 'Sends a ' + method + ' to ' + String(args.url ?? '') + ', which acts on that service.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'chrome_open_tab': {
      const includeContext = args.includeContext === true;
      const destination = String(args.url ?? '');
      return {
        tier: 'confirm',
        reason: includeContext
          ? 'Opens a web page and explicitly sends its visible contents to the model.'
          : 'Interacts with a web page, which can trigger real actions.',
        signature: signatureFor('chrome_open_tab', includeContext ? destination + '|include-context' : destination),
        ...(includeContext ? { requiresExplicitConfirmation: true } : {}),
      };
    }

    case 'chrome_scroll':
    case 'chrome_press_key':
      return {
        tier: 'confirm',
        reason: 'Interacts with a web page, which can trigger real actions.',
        signature: signatureFor(toolName, String(args.url ?? args.key ?? 'page')),
      };
    case 'screen_capture':
      // Reads the screen rather than changing it, but a screenshot can contain
      // anything on show, so it is worth seeing the request go by.
      return {
        tier: 'confirm',
        reason: 'Captures your screen and sends the image to the model.',
        requiresExplicitConfirmation: true,
      };

    case 'list_lessons':
      return {
        tier: 'confirm',
        reason: 'Reads saved learning-memory entries and sends them to the model.',
        requiresExplicitConfirmation: true,
      };

    case 'remember_lesson':
      return {
        tier: 'confirm',
        reason: 'Writes a note to the saved learning-memory store.',
        requiresExplicitConfirmation: true,
      };

    case 'edit_lesson':
      return { tier: 'confirm', reason: 'Changes a saved learning-memory entry.', requiresExplicitConfirmation: true };
    case 'delete_lesson':
      return { tier: 'confirm', reason: 'Deletes a saved learning-memory entry.', requiresExplicitConfirmation: true };
    case 'list_mutations':
      return {
        tier: 'auto',
        reason: 'Lists bounded mutation metadata without reading file contents.',
      };

    case 'undo_mutation':
      return { tier: 'confirm', reason: 'Reverses a previously verified file mutation after checking its current state.' };

    case 'run_batch': {
      const commands = (args.commands as string[]) ?? [];
      for (const c of commands) {
        const why = denyCheck(c);
        if (why) return { tier: 'never', reason: `Blocked: one command ${why}.` };
      }
      if (args.preview === true) {
        return { tier: 'auto', reason: 'Previews the selected batch plan without executing commands.' };
      }
      // A batch is only as safe as its least safe command.
      if (commands.length > 0 && commands.every((c) => isReadonlyShell(c))) {
        return { tier: 'auto', reason: 'Every command in the batch is read-only.' };
      }
      return {
        tier: 'confirm',
        reason: 'Runs several shell commands, at least one of which can change your system.',
        signature: signatureFor('run_batch', commands.join(' ;; ')),
        requiresExplicitConfirmation: true,
      };
    }

    case 'list_skills':
    case 'find_skills':
    case 'preview_skill':
    case 'inspect_skill':
    case 'skills_folder':
      return {
        tier: 'auto',
        reason: 'Reads bounded capability-package metadata without enabling or running downloaded code.',
      };

    case 'disable_skill':
      return {
        tier: 'auto',
        reason: 'Turns off an installed capability pack without deleting it.',
      };

    case 'install_skill':
      return {
        tier: 'confirm',
        reason: 'Downloads an untrusted capability package into the Adi skills folder. It stays disabled.',
        requiresExplicitConfirmation: true,
      };

    case 'create_skill': {
      let serialized = '';
      try {
        serialized = JSON.stringify(args.manifest ?? {});
      } catch {
        return { tier: 'never', reason: 'Blocked: the skill manifest cannot be inspected.' };
      }
      const why = denyCheck(serialized);
      if (why) return { tier: 'never', reason: 'Blocked: the local skill manifest ' + why + '.' };
      return {
        tier: 'confirm',
        reason: 'Saves instructions and optional executable tool definitions as a disabled local skill.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'enable_skill':
      return {
        tier: 'confirm',
        reason: 'Lets an installed package influence future model prompts and expose its bundled tools.',
        requiresExplicitConfirmation: true,
      };

    case 'update_skill':
      return {
        tier: 'confirm',
        reason: 'Replaces an installed package with newly downloaded untrusted content and disables it.',
        requiresExplicitConfirmation: true,
      };

    case 'remove_skill':
      return {
        tier: 'confirm',
        reason: 'Deletes one installed capability package from the Adi skills folder.',
        requiresExplicitConfirmation: true,
      };
    case 'create_tool': {
      const script = String(args.script ?? '');
      const why = denyCheck(script);
      if (why) return { tier: 'never', reason: `Blocked: the tool script ${why}.` };
      // No signature: every new tool must be read and approved on its own.
      return {
        tier: 'confirm',
        reason: 'Saves a new tool it can run later. Read the script before allowing.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'create_api_tool': {
      const target = `${String(args.method ?? 'GET')} ${String(args.url ?? '')} ${String(args.body ?? '')}`;
      const why = denyCheck(target);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Saves a web API as a tool it can call later. Check the URL and what it sends.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'create_workflow': {
      // A workflow cannot smuggle anything past the gate — every step is
      // classified again when it runs — but it is still worth reading, because
      // a list of steps is a plan and the plan is the thing being approved.
      const steps = (args.steps as { tool?: string }[]) ?? [];
      for (const step of steps) {
        const inner = classify(String(step.tool ?? ''), {});
        if (inner.tier === 'never') {
          return { tier: 'never', reason: `Blocked: step "${String(step.tool)}" ${inner.reason}` };
        }
      }
      return {
        tier: 'confirm',
        reason: 'Saves several tools as one. Each step still asks for itself when it runs.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'inspect_tool':
      return { tier: 'auto', reason: 'Shows one of its own tools without running it.' };

    /* ------------------------------------------------------------- goals */

    case 'list_goals':
      return {
        tier: 'confirm',
        reason: 'Reads durable goals, deadlines, and progress notes and sends them to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'add_goal_progress':
    case 'finish_goal':
      return { tier: 'auto', reason: 'Reads or updates the goals you set. Touches nothing else.' };

    case 'check_goal':
      // The same standing as screen_capture: it reads the screen rather than
      // changing it, and the screen is already in front of you.
      return {
        tier: 'confirm',
        reason: 'Captures your screen to check the goal and sends the image to the model.',
        requiresExplicitConfirmation: true,
      };

    case 'set_goal':
      // Setting a goal is harmless; setting one that *watches* schedules
      // repeated screenshots, which is a standing arrangement and must be asked
      // for explicitly rather than slipped in with the goal.
      return args.watchEveryMinutes
        ? {
            tier: 'confirm',
            reason: `Sets a goal AND starts taking a screenshot every ${Math.max(10, Math.round(Number(args.watchEveryMinutes)))} minutes to check on it.`,
            requiresExplicitConfirmation: true,
          }
        : { tier: 'auto', reason: 'Remembers something you are working toward.' };

    case 'list_assignments':
    case 'get_assignment':
    case 'get_assignment_context':
      return {
        tier: 'confirm',
        reason: 'Reads durable assignment details, notes, and sources and sends them to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'create_assignment':
    case 'update_assignment':
    case 'add_assignment_item':
    case 'complete_assignment_item':
    case 'add_assignment_note':
    case 'add_assignment_source':
    case 'transition_assignment':
    case 'set_assignment_rubric':
    case 'add_assignment_feedback':
    case 'add_assignment_research':
    case 'add_assignment_citation':
    case 'add_assignment_learning_goal':
    case 'add_assignment_material':
    case 'link_generated_artifact':
      return { tier: 'auto', reason: 'Reads or updates the durable assignment records. Touches nothing else.' };
    case 'record_research_finding':
      return { tier: 'auto', reason: 'Reads or updates the bounded local research ledger.' };
    case 'list_research':
    case 'get_research_context':
      return {
        tier: 'confirm',
        reason: 'Reads durable research findings and citations and sends them to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'get_project':
    case 'list_projects':
    case 'get_project_context':
      return {
        tier: 'confirm',
        reason: 'Reads durable project metadata and linked personal records and sends them to the model.',
        requiresExplicitConfirmation: true,
      };
    case 'create_project':
    case 'update_project':
      return args.workspaceRoot !== undefined && String(args.workspaceRoot).trim()
        ? { tier: 'confirm', reason: 'Stores a user-selected workspace path as project metadata; no files are read.' }
        : { tier: 'auto', reason: 'Creates or updates local project metadata.' };
    case 'transition_project':
      return { tier: 'auto', reason: 'Updates the durable project lifecycle state.' };
    case 'watch_goal':
      return Number(args.everyMinutes ?? 0) > 0
        ? {
            tier: 'confirm',
            reason: `Starts taking a screenshot every ${Math.max(10, Math.round(Number(args.everyMinutes)))} minutes to check on this goal.`,
            requiresExplicitConfirmation: true,
          }
        : { tier: 'auto', reason: 'Stops checking in on a goal.' };

    case 'test_tool':
      // Running a tool is running a tool, whatever it is called from.
      return {
        tier: 'confirm',
        reason: 'Runs one of its own tools to check that it works.',
        requiresExplicitConfirmation: true,
      };

    case 'delete_tool':
      return {
        tier: 'confirm',
        reason: 'Deletes one of its own custom tools.',
        signature: signatureFor('delete_tool', String(args.name ?? '')),
        requiresExplicitConfirmation: true,
      };

    case 'read_gmail':
    case 'read_gmail_message':
    case 'read_classroom':
    case 'read_google_doc':
    case 'find_google_docs':
      // Reading the user's own mail and coursework, in the browser profile they
      // chose. It changes nothing, but it is their correspondence, so it asks
      // once and the signature is per-tool: approving "read my inbox" covers
      // any search, since the query does not change what is at stake.
      return {
        tier: 'confirm',
        reason: 'Reads your Google account in the browser profile you selected.',
        signature: signatureFor(toolName, 'read'),
        requiresExplicitConfirmation: true,
      };

    case 'delete_item': {
      const path = String(args.path ?? '');
      const why = protectedPathReason(path);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      // Recycling is undoable; permanent deletion is not, so it is never
      // remembered — each one is asked about on its own.
      const permanent = Boolean(args.permanent);
      return {
        tier: 'confirm',
        reason: permanent
          ? 'Deletes permanently, skipping the recycle bin. This cannot be undone.'
          : 'Sends this to the recycle bin.',
        signature: permanent ? undefined : signatureFor('delete_item', path),
      };
    }

    case 'move_item':
    case 'copy_item': {
      const from = String(args.from ?? '');
      const to = String(args.to ?? '');
      // Moving *out of* a protected path is as destructive as deleting it, and
      // writing *into* one is how a system file gets replaced.
      const why =
        (toolName === 'move_item' ? protectedPathReason(from) : null) ?? protectedPathReason(to);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: toolName === 'move_item' ? 'Moves a file on disk.' : 'Copies a file on disk.',
        signature: signatureFor(toolName, `${from}|${to}`),
      };
    }

    case 'kill_process':
      return {
        tier: 'confirm',
        reason: 'Stops a running program. Unsaved work in it will be lost.',
        signature: signatureFor('kill_process', String(args.target ?? '')),
      };

    case 'open_path': {
      const target = String(args.target ?? '');
      const why = denyCheck(target);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      // Opening runs whatever the file is associated with, including .exe.
      return {
        tier: 'confirm',
        reason: 'Opens this with its default program.',
        signature: signatureFor('open_path', target),
      };
    }

    case 'reveal_path':
    case 'focus_window':
    case 'notify':
    case 'media_key':
      return { tier: 'auto', reason: 'Changes what is on screen but touches no data.' };

    case 'write_clipboard':
      return {
        tier: 'confirm',
        reason: 'Replaces the clipboard contents; the current clipboard value will be lost.',
        requiresExplicitConfirmation: true,
      };

    case 'update_tool': {
      const script = String(args.script ?? '');
      const why = denyCheck(script);
      if (why) return { tier: 'never', reason: `Blocked: the tool script ${why}.` };
      // Like create_tool, no signature: changed code must be read each time.
      return {
        tier: 'confirm',
        reason: 'Rewrites one of its own tools. Read the script before allowing.',
        requiresExplicitConfirmation: true,
      };
    }

    case 'create_folder': {
      const path = String(args.path ?? '');
      const why = protectedPathReason(path);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Creates a folder on disk.',
        signature: signatureFor('create_folder', path),
      };
    }

    case 'chrome_restart_for_automation':
      return {
        tier: 'confirm',
        reason: 'Closes and reopens your Chrome. Tabs are restored, but unsaved page input is not.',
        requiresExplicitConfirmation: true,
        signature: signatureFor('chrome_restart_for_automation', 'restart'),
      };

    case 'chrome_use_profile':
      return {
        tier: 'confirm',
        reason:
          String(args.mode) === 'system'
            ? 'Switches automation to your real Chrome profile, which has your logged-in accounts.'
            : 'Switches automation back to the isolated pet profile.',
        requiresExplicitConfirmation: true,
        signature: signatureFor('chrome_use_profile', `${String(args.mode)}:${String(args.profileDir ?? '')}`),
      };

    case 'registry_read': {
      const key = String(args.key ?? '');
      const why = denyCheck(key);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return { tier: 'auto', reason: 'Reads a registry value.' };
    }

    /* ------------------------------------------------ confirm-first tools */
    case 'workspace_context':
      return {
        tier: 'confirm',
        reason: 'Shares bounded workspace names and project markers with the model.',
        requiresExplicitConfirmation: true,
      };
    case 'run_powershell':
    case 'run_cmd': {
      const command = String(args.command ?? '');
      const why = denyCheck(command);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      if (isReadonlyShell(command)) {
        return { tier: 'auto', reason: 'Recognized read-only command.' };
      }
      return {
        tier: 'confirm',
        reason: 'Runs a shell command that can change your system.',
        requiresExplicitConfirmation: true,
        signature: signatureFor(toolName, command),
      };
    }

    case 'write_file':
    case 'edit_file': {
      const path = String(args.path ?? '');
      const why = protectedPathReason(path);
      if (why) return { tier: 'never', reason: `Blocked: that path ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Modifies a file on disk.',
        signature: signatureFor(toolName, path),
      };
    }

    case 'registry_write': {
      const key = String(args.key ?? '');
      if (REGISTRY_WRITE_DENY.test(key)) {
        return { tier: 'never', reason: 'Blocked: writes to a protected registry hive.' };
      }
      const why = denyCheck(`${key} ${String(args.value ?? '')}`);
      if (why) return { tier: 'never', reason: `Blocked: ${why}.` };
      return {
        tier: 'confirm',
        reason: 'Changes a Windows setting via the registry.',
        signature: signatureFor(toolName, key),
      };
    }

    case 'chrome_continue_login':
      return {
        tier: 'confirm',
        reason:
          'Continues the visible sign-in flow in one existing locked browser tab. It may click account, Next, verification, or Sign in controls.',
        signature: signatureFor('request:browser-login', String(args.tabId ?? 'active-tab')),
        taskApprovalAllowed: true,
        requiresExplicitConfirmation: true,
      };
    case 'chrome_sequence':
      return {
        tier: 'confirm',
        reason: 'Runs multiple browser interactions in one existing tab; the complete plan is shown before it runs.',
      };
    case 'chrome_navigate': {
      const includeContext = args.includeContext === true;
      const destination = String(args.url ?? '');
      return {
        tier: 'confirm',
        reason: includeContext
          ? 'Navigates to a web page and explicitly sends its visible contents to the model.'
          : 'Interacts with a web page, which can trigger real actions.',
        signature: signatureFor('chrome_navigate', includeContext ? destination + '|include-context' : destination),
        ...(includeContext ? { requiresExplicitConfirmation: true } : {}),
      };
    }

    case 'chrome_click':
    case 'chrome_click_text':
    case 'chrome_type':
    case 'chrome_fill_field':
      return {
        tier: 'confirm',
        reason: 'Interacts with a web page, which can trigger real actions.',
        signature: signatureFor(toolName, String(args.url ?? args.selector ?? '')),
      };
    /* ------------------------------------------------------------ default */
    default:
      if (toolName.startsWith('mcp__')) {
        // MCP tools are somebody else's code doing something this app cannot
        // inspect. They are never auto-tier, and the signature is per-tool
        // rather than per-argument, so trusting "read a Notion page" does not
        // silently extend to "delete a Notion page" from the same server.
        return {
          tier: 'confirm',
          reason: `Runs a tool provided by the "${toolName.split('__')[1]}" MCP server.`,
          signature: signatureFor(toolName, 'mcp-tool'),
          requiresExplicitConfirmation: true,
        };
      }
      // A workflow is a container, not an action. Every step inside it is
      // classified and confirmed on its own when it runs, so prompting for the
      // wrapper as well would ask twice and — worse — ask about an abstraction
      // ("run workflow X") instead of about what is really going to happen.
      // A workflow of read-only steps is therefore read-only, which is correct.
      try {
        const dynamic = dynamicTool === undefined ? findCustomTool(toolName) : dynamicTool;
        if (dynamic?.kind === 'http') {
          return {
            tier: 'confirm',
            reason: 'Runs a saved API tool that can send data to an external service.',
            requiresExplicitConfirmation: true,
          };
        }
        if (dynamic && (dynamic.kind ?? 'script') === 'script') {
          return {
            tier: 'confirm',
            reason: 'Runs a user-created script on this machine.',
            requiresExplicitConfirmation: true,
          };
        }
        if (dynamic?.kind === 'workflow') {
          return {
            tier: 'auto',
            reason: 'Runs existing tools in order. Each step asks for itself.',
          };
        }
      } catch {
        /* no tools folder yet */
      }

      // Unknown tool: confirm rather than assume. Never auto-allow by default.
      return { tier: 'confirm', reason: 'Unrecognized tool — confirming to be safe.' };
  }
}

/** Tools 'auto-edit' covers: changes to files, but nothing that executes. */
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'create_folder']);

/**
 * Whether the current mode lets a confirm-tier call run without asking.
 *
 * Only ever consulted for the 'confirm' tier. 'never' is checked first and has
 * no mode that unlocks it — that is the point of the tier.
 */
export function autoApproves(mode: ApprovalMode, toolName: string, requiresExplicitConfirmation = false): boolean {
  // Full auto is the user's explicit, global choice to skip confirm-tier
  // prompts. The permanent never tier is resolved before this helper and
  // remains blocked. Explicit-confirmation flags still constrain saved
  // grants and Auto edits, but must not secretly turn Full auto into Ask.
  if (mode === 'auto') return true;
  if (requiresExplicitConfirmation) return false;
  if (mode === 'auto-edit') return EDIT_TOOLS.has(toolName);
  return false;
}

export function shouldAutoApprove(
  mode: ApprovalMode,
  toolName: string,
  tier: PermissionTier,
  requiresExplicitConfirmation: boolean,
  preApproved: boolean,
  sessionApproved: boolean,
): boolean {
  return (
    tier === 'confirm' &&
    !preApproved &&
    !sessionApproved &&
    autoApproves(mode, toolName, requiresExplicitConfirmation)
  );
}
/** Final gate: applies the allowlist on top of classification. */
export function resolve(
  toolName: string,
  args: Record<string, unknown>,
  dynamicTool?: CustomTool | null,
  operationId?: string,
): Classification & { preApproved: boolean; sessionApproved: boolean; taskApproved: boolean } {
  const c = classify(toolName, args, dynamicTool);
  // The allowlist can only upgrade 'confirm' to silent-run. It can never
  // override 'never' — that tier has no override path by design.
  const preApproved = c.tier === 'confirm' && !!c.signature && isAllowlisted(c.signature);
  const sessionApproved =
    sessionApprovalAllowed(c) && isSessionAllowlisted(c.signature!);
  const taskApproved = Boolean(
    operationId && taskApprovalAllowed(c) && isTaskAllowlisted(operationId, c.signature!),
  );
  return { ...c, preApproved, sessionApproved, taskApproved };
}
