import { clipboard } from 'electron';
import { runFast, runFastStrict } from './pshost';
import { waitWithAbort } from '../abort';
import { MODIFIERS, USER32, VK } from './interop';

/**
 * Synthetic mouse and keyboard input — the part of "computer use" that goes
 * beyond looking at the screen.
 *
 * These go to whatever happens to be focused, which is exactly why every one of
 * them is confirm-tier: a click at a coordinate is a click on whatever is under
 * it, and the agent's picture of the screen is a screenshot from a moment ago.
 * Pair them with screen_capture, or with window_bounds so the coordinate is
 * computed from where the window actually is.
 */

/**
 * user32 bindings, declared once per PowerShell process.
 *
 * SendInput rather than the older mouse_event/keybd_event for keystrokes,
 * because it is the only route that can type a character the current keyboard
 * layout has no key for — an accent, a dash, an emoji. SendKeys cannot, and
 * silently drops them.
 */


const BUTTONS: Record<string, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

function button(name: string) {
  const requested = name.trim().toLowerCase();
  const value = BUTTONS[requested];
  if (!value) throw new Error(`Unknown mouse button "${name}". Use left, right, or middle.`);
  return value;
}

const px = (n: number) => {
  if (!Number.isFinite(n)) throw new Error('Screen coordinates must be finite numbers.');
  return Math.round(n);
};

async function runWithCancellationCleanup(
  script: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cleanup: string,
): Promise<string> {
  try {
    return await runFastStrict(script, timeoutMs, signal);
  } catch (error) {
    if (signal?.aborted) await runFastStrict(`${USER32}\n${cleanup}`, 10_000).catch(() => undefined);
    throw error;
  }
}

function readClipboardTextSafely(): string | undefined {
  try {
    return clipboard?.readText?.();
  } catch {
    return undefined;
  }
}

function restoreClipboardIfUnchanged(previous: string | undefined, pasted: string): void {
  if (previous === undefined) return;
  try {
    if (clipboard.readText() !== pasted) return;
    if (previous) clipboard.writeText(previous);
    else clipboard.clear();
  } catch {
    /* Clipboard restoration is best effort; preserve the original tool error. */
  }
}
export async function getCursorPosition(signal?: AbortSignal): Promise<string> {
  return runFast(
    `${USER32}
$p = New-Object AdiInput+POINT
[void][AdiInput]::GetCursorPos([ref]$p)
"Cursor is at $($p.X), $($p.Y)"`, undefined, signal
  );
}

export async function moveMouse(x: number, y: number, signal?: AbortSignal): Promise<string> {
  return runFastStrict(
    `${USER32}
[AdiInput]::MoveCursor(${px(x)}, ${px(y)})
"Moved the pointer to ${px(x)}, ${px(y)}"`, undefined, signal
  );
}

export async function clickMouse(
  x: number | undefined,
  y: number | undefined,
  btn = 'left',
  double = false,
  signal?: AbortSignal
): Promise<string> {
  if ((x === undefined) !== (y === undefined)) {
    throw new Error('Click coordinates must include both x and y, or neither.');
  }
  const b = button(btn);
  const move =
    x !== undefined && y !== undefined
      ? `[AdiInput]::MoveCursor(${px(x)}, ${px(y)})\nStart-Sleep -Milliseconds 60`
      : '';
  const oneClick = `[AdiInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[AdiInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)`;

  return runFastStrict(
    `${USER32}
${move}
${oneClick}
${double ? `Start-Sleep -Milliseconds 90\n${oneClick}` : ''}
"${double ? 'Double-clicked' : 'Clicked'} the ${btn} button${x !== undefined ? ` at ${px(x)}, ${px(y ?? 0)}` : ' where the pointer was'}."`, undefined, signal
  );
}

/**
 * Press at one point, move, release at another.
 *
 * The intermediate steps are not decoration: an application that tracks the
 * drag — selecting text, dragging a file, moving a window — sees a jump from A
 * straight to B as no drag at all, and does nothing.
 */
export async function dragMouse(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  btn = 'left',
  steps = 20,
  signal?: AbortSignal,
): Promise<string> {
  const b = button(btn);
  const n = Math.min(60, Math.max(2, Math.round(steps)));
  return runWithCancellationCleanup(
    `${USER32}
[AdiInput]::MoveCursor(${px(fromX)}, ${px(fromY)})
Start-Sleep -Milliseconds 80
[AdiInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
for ($i = 1; $i -le ${n}; $i++) {
  $x = ${px(fromX)} + ((${px(toX)} - ${px(fromX)}) * $i / ${n})
  $y = ${px(fromY)} + ((${px(toY)} - ${px(fromY)}) * $i / ${n})
  [AdiInput]::MoveCursor([int]$x, [int]$y)
  Start-Sleep -Milliseconds 12
}
Start-Sleep -Milliseconds 80
[AdiInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)
"Dragged from ${px(fromX)}, ${px(fromY)} to ${px(toX)}, ${px(toY)}."`,
    60_000,
    signal,
    `[AdiInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)`,
  );
}

/** Half a click. Paired with mouse_up for gestures nothing else expresses. */
export async function mouseDown(x?: number, y?: number, btn = 'left', signal?: AbortSignal): Promise<string> {
  if ((x === undefined) !== (y === undefined)) {
    throw new Error('Mouse-down coordinates must include both x and y, or neither.');
  }
  const b = button(btn);
  return runFastStrict(
    `${USER32}
${x !== undefined && y !== undefined ? `[AdiInput]::MoveCursor(${px(x)}, ${px(y)})` : ''}
[AdiInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
"Holding the ${btn} button down."`, undefined, signal
  );
}

export async function mouseUp(btn = 'left', signal?: AbortSignal): Promise<string> {
  const b = button(btn);
  return runFastStrict(
    `${USER32}
[AdiInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)
"Released the ${btn} button."`, undefined, signal
  );
}

const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;

export async function scrollMouse(amount: number, horizontal = false, signal?: AbortSignal): Promise<string> {
  // One notch is 120 units; positive scrolls up, matching a real wheel.
  if (!Number.isFinite(amount)) throw new Error('Scroll amount must be a finite number.');
  const delta = Math.round(amount) * 120;
  const flag = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
  const dir = horizontal ? (delta >= 0 ? 'right' : 'left') : delta >= 0 ? 'up' : 'down';
  return runFastStrict(
    `${USER32}
[AdiInput]::mouse_event(${flag}, 0, 0, ${delta}, [IntPtr]::Zero)
"Scrolled ${Math.abs(Math.round(amount))} notch(es) ${dir}."`, undefined, signal
  );
}

function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Types text literally into the focused window.
 *
 * Goes through SendInput in unicode mode rather than SendKeys, so an em dash,
 * an accent or an emoji arrives as itself. SendKeys would also have read
 * +^%~(){}[] as chord syntax, quietly turning an email address into a handful
 * of Shift and Ctrl combinations.
 */
export async function typeText(text: string, perCharMs = 2, signal?: AbortSignal): Promise<string> {
  if (!Number.isFinite(perCharMs) || perCharMs < 0) throw new Error('Per-character delay must be a finite non-negative number.');
  const delay = Math.min(200, Math.max(0, Math.round(perCharMs)));
  return runFastStrict(
    `${USER32}
[AdiInput]::TypeUnicode(${psLiteral(text)}, ${delay})
"Typed ${text.length} characters into the focused window."`,
    // A slow, deliberate rate on a long string can outlast the default budget.
    Math.max(60_000, text.length * delay * 3),
    signal,
  );
}

/**
 * Raw SendKeys chords: ^ is Ctrl, % is Alt, + is Shift, and named keys go in
 * braces — "^s" saves, "%{F4}" closes, "{ENTER}" is return.
 */
export async function pressKeys(keys: string, signal?: AbortSignal): Promise<string> {
  if (!keys) throw new Error('A key sequence is required.');
  return runFastStrict(
    `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(keys)})
"Sent ${keys.replace(/"/g, '')}"`, undefined, signal
  );
}


/**
 * Holds a key down for a while, which chorded keystrokes cannot express — a
 * game's movement key, a scroll-accelerator, a press-and-hold menu.
 */
export async function holdKey(key: string, ms: number, signal?: AbortSignal): Promise<string> {
  const vk = VK[key.toLowerCase()];
  if (!vk) {
    throw new Error(`Cannot hold "${key}". Known keys: ${Object.keys(VK).join(', ')}.`);
  }
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Key hold duration must be a finite non-negative number.');
  const duration = Math.min(10_000, Math.max(10, Math.round(ms)));
  return runWithCancellationCleanup(
    `${USER32}
[AdiInput]::KeyDown(${vk})
Start-Sleep -Milliseconds ${duration}
[AdiInput]::KeyUp(${vk})
"Held ${key} for ${duration}ms."`,
    60_000,
    signal,
    `[AdiInput]::KeyUp(${vk})`,
  );
}

/**
 * The colour of one screen pixel.
 *
 * Cheap way to answer "did that actually change?" after a click, without
 * spending a whole screenshot and a vision round trip on it.
 */
export async function pixelColor(x: number, y: number, signal?: AbortSignal): Promise<string> {
  return runFast(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1,1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${px(x)}, ${px(y)}, 0, 0, (New-Object System.Drawing.Size 1,1))
$c = $bmp.GetPixel(0,0)
$g.Dispose(); $bmp.Dispose()
"Pixel ${px(x)}, ${px(y)} is #{0:X2}{1:X2}{2:X2}  (r={0} g={1} b={2})" -f $c.R, $c.G, $c.B
`, undefined, signal);
}

/**
 * Waits. Interfaces animate, load and settle, and acting into a half-drawn
 * window is how a click lands on the thing that was there a moment ago.
 */
export async function waitMs(ms: number, signal?: AbortSignal): Promise<string> {
  const duration = Math.min(30_000, Math.max(0, Math.round(ms)));
  await waitWithAbort(new Promise((r) => setTimeout(r, duration)), signal);
  return `Waited ${duration}ms.`;
}

/* ------------------------------------------------------------ text entry */

/**
 * Pastes text through the clipboard instead of typing it.
 *
 * Typing 2,000 characters at 2ms each is four seconds of SendInput; a paste is
 * one keystroke. The clipboard is put back afterwards, because quietly eating
 * whatever the user had copied is its own small betrayal.
 */
export async function pasteText(text: string, restoreClipboard = true, signal?: AbortSignal): Promise<string> {
  const previous = restoreClipboard ? readClipboardTextSafely() : undefined;
  try {
    return await runFastStrict(
    `${USER32}
Add-Type -AssemblyName System.Windows.Forms
$previous = ''
try { $previous = [System.Windows.Forms.Clipboard]::GetText() } catch { }
[System.Windows.Forms.Clipboard]::SetText(${psLiteral(text)})
Start-Sleep -Milliseconds 80
[AdiInput]::Chord(@(0x11), 0x56)
Start-Sleep -Milliseconds 150
${restoreClipboard
  ? `if ($previous) { try { [System.Windows.Forms.Clipboard]::SetText($previous) } catch { } } else { try { [System.Windows.Forms.Clipboard]::Clear() } catch { } }`
  : ''}
"Pasted ${text.length} characters into the focused window."`,
    60_000,
    signal,
    );
  } catch (error) {
    restoreClipboardIfUnchanged(previous, text);
    throw error;
  }
}

/** Selects everything in the focused field and replaces it. */
export async function clearAndType(text: string, signal?: AbortSignal): Promise<string> {
  return runFastStrict(
    `${USER32}
[AdiInput]::Chord(@(0x11), 0x41)
Start-Sleep -Milliseconds 60
[AdiInput]::KeyDown(0x2E)
[AdiInput]::KeyUp(0x2E)
Start-Sleep -Milliseconds 60
[AdiInput]::TypeUnicode(${psLiteral(text)}, 2)
"Cleared the field and typed ${text.length} characters."`,
    Math.max(60_000, text.length * 2 * 3),
    signal,
  );
}

/**
 * A keyboard shortcut written the way people say it: "ctrl+shift+n".
 *
 * press_keys takes SendKeys syntax, which is powerful and entirely unmemorable
 * — "^+{ESC}" is Ctrl+Shift+Escape. This takes the names instead, and goes
 * through SendInput so it behaves identically in applications that ignore
 * SendKeys.
 */
export async function keyCombo(combo: string, signal?: AbortSignal): Promise<string> {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Empty key combination.');

  const mods: number[] = [];
  let key = 0;
  for (const part of parts) {
    const code = VK[part];
    if (code === undefined) {
      throw new Error(`Unknown key "${part}" in "${combo}". Known: ${Object.keys(VK).join(', ')}.`);
    }
    if (MODIFIERS.has(part)) mods.push(code);
    else key = code;
  }
  if (!key) throw new Error(`"${combo}" must include a non-modifier key.`);

  return runFastStrict(
    `${USER32}
[AdiInput]::Chord(@(${mods.join(', ') || ''}), ${key})
"Pressed ${combo}."`, undefined, signal
  );
}

/* -------------------------------------------------------------- sequences */

export interface InputStep {
  action: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  ms?: number;
  amount?: number;
  button?: string;
}

/**
 * A whole interaction in one call.
 *
 * This is the difference between the pet being able to work a dialog and not.
 * Filling a login form is click, type, tab, type, enter — five tool calls, five
 * model round trips, several seconds each, and the screen has moved on by the
 * time the third one lands. As one sequence it is a few hundred milliseconds
 * and the steps stay in step with each other.
 *
 * The whole sequence is shown to the user before any of it runs.
 */
export async function inputSequence(steps: InputStep[], signal?: AbortSignal): Promise<string> {
  if (!Array.isArray(steps)) throw new Error('Input steps must be an array.');
  if (!steps.length) return 'No steps given.';
  if (steps.length > 40) throw new Error('That is more than 40 steps; break it up.');

  const lines: string[] = [USER32, 'Add-Type -AssemblyName System.Windows.Forms'];
  const log: string[] = [];

  for (const [i, step] of steps.entries()) {
    const action = String(step.action ?? '').toLowerCase();
    if (step.ms !== undefined && (!Number.isFinite(step.ms) || step.ms < 0)) throw new Error(`Step ${i + 1}: pause must be a finite non-negative number.`);
    const pause = step.ms === undefined ? 120 : Math.min(10_000, Math.max(0, Math.round(step.ms)));

    switch (action) {
      case 'click':
      case 'doubleclick':
      case 'rightclick': {
        if ((step.x === undefined) !== (step.y === undefined)) {
          throw new Error(`Step ${i + 1}: click coordinates must include both x and y, or neither.`);
        }
        const b = button(action === 'rightclick' ? 'right' : (step.button ?? 'left'));
        if (step.x !== undefined && step.y !== undefined) {
          lines.push(`[AdiInput]::MoveCursor(${px(step.x)}, ${px(step.y)})`);
          lines.push('Start-Sleep -Milliseconds 60');
        }
        const one = `[AdiInput]::mouse_event(${b.down}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[AdiInput]::mouse_event(${b.up}, 0, 0, 0, [IntPtr]::Zero)`;
        lines.push(one);
        if (action === 'doubleclick') lines.push('Start-Sleep -Milliseconds 90', one);
        log.push(`${i + 1}. ${action}${step.x !== undefined ? ` at ${px(step.x)}, ${px(step.y ?? 0)}` : ''}`);
        break;
      }
      case 'move':
        if (step.x === undefined || step.y === undefined) {
          throw new Error(`Step ${i + 1}: move requires both x and y coordinates.`);
        }
        lines.push(`[AdiInput]::MoveCursor(${px(step.x ?? 0)}, ${px(step.y ?? 0)})`);
        log.push(`${i + 1}. move to ${px(step.x ?? 0)}, ${px(step.y ?? 0)}`);
        break;
      case 'type':
        if (typeof step.text !== 'string') throw new Error(`Step ${i + 1}: type requires text.`);
        lines.push(`[AdiInput]::TypeUnicode(${psLiteral(step.text)}, 2)`);
        log.push(`${i + 1}. type "${step.text.slice(0, 40)}"`);
        break;
      case 'paste':
        if (typeof step.text !== 'string') throw new Error(`Step ${i + 1}: paste requires text.`);
        lines.push(
          `[System.Windows.Forms.Clipboard]::SetText(${psLiteral(step.text)})`,
          'Start-Sleep -Milliseconds 80',
          '[AdiInput]::Chord(@(0x11), 0x56)',
        );
        log.push(`${i + 1}. paste "${step.text.slice(0, 40)}"`);
        break;
      case 'key': {
        const combo = String(step.key ?? '').toLowerCase();
        const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
        if (!parts.length) throw new Error(`Step ${i + 1}: key requires a non-empty combination.`);
        const mods: number[] = [];
        let code = 0;
        for (const part of parts) {
          const vk = VK[part];
          if (vk === undefined) throw new Error(`Step ${i + 1}: unknown key "${part}".`);
          if (MODIFIERS.has(part)) mods.push(vk);
          else code = vk;
        }
        if (!code) throw new Error(`Step ${i + 1}: key must include a non-modifier key.`);
        lines.push(`[AdiInput]::Chord(@(${mods.join(', ')}), ${code})`);
        log.push(`${i + 1}. press ${combo}`);
        break;
      }
      case 'scroll':
        {
        const amount = step.amount === undefined ? -1 : step.amount;
        if (!Number.isFinite(amount)) throw new Error(`Step ${i + 1}: scroll amount must be finite.`);
        lines.push(
          `[AdiInput]::mouse_event(0x0800, 0, 0, ${Math.round(amount) * 120}, [IntPtr]::Zero)`,
        );
        log.push(`${i + 1}. scroll ${amount}`);
        }
        break;
      case 'wait':
        log.push(`${i + 1}. wait ${pause}ms`);
        break;
      default:
        throw new Error(
          `Step ${i + 1}: unknown action "${step.action}". Use click, doubleclick, rightclick, move, type, paste, key, scroll or wait.`,
        );
    }
    lines.push(`Start-Sleep -Milliseconds ${pause}`);
  }

  const total = steps.reduce((n, s) => n + (s.ms === undefined ? 120 : Number(s.ms) || 0), 0);
  lines.push(`"Ran ${steps.length} step(s)."`);
  const out = await runFastStrict(lines.join('\n'), Math.max(60_000, total + 30_000), signal);
  return `${out}\n${log.join('\n')}`;
}

/** Describes a sequence for the confirmation prompt, one step per line. */
export function describeSequence(steps: InputStep[]): string {
  return steps
    .map((s, i) => {
      const a = String(s.action ?? '').toLowerCase();
      if (a === 'type' || a === 'paste') return `${i + 1}. ${a} "${String(s.text ?? '').slice(0, 60)}"`;
      if (a === 'key') return `${i + 1}. press ${s.key}`;
      if (a === 'wait') return `${i + 1}. wait ${s.ms ?? 120}ms`;
      if (a === 'scroll') return `${i + 1}. scroll ${s.amount ?? -1}`;
      if (s.x !== undefined) return `${i + 1}. ${a} at ${s.x}, ${s.y ?? 0}`;
      return `${i + 1}. ${a}`;
    })
    .join('\n');
}
