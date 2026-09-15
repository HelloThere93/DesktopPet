/**
 * The C# the tools P/Invoke through, in one place.
 *
 * These live here rather than beside their tools so the shared PowerShell host
 * can compile them once at startup. Each block keeps its own
 * `if (-not ('X' -as [type]))` guard, so a tool that runs in a fresh process —
 * or before the host has warmed up — still works; the guard simply finds the
 * type already there.
 */

/**
 * Mouse and keyboard.
 *
 * SendInput rather than the older keybd_event for keystrokes, because it is the
 * only route that can type a character the current keyboard layout has no key
 * for: an accent, a dash, an emoji.
 */
export const USER32 = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class AdiInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  public static void MoveCursor(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("Windows rejected cursor positioning.");
  }
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT KeyChar(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = (ushort)c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  static INPUT KeyCode(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return i;
  }

  static void Emit(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("Windows accepted only " + sent + " of " + inputs.Length + " input event(s).");
  }

  /**
   * Types a string literally, whatever the keyboard layout can or cannot reach.
   * The pause between characters is what stops fast applications dropping them.
   */
  public static void TypeUnicode(string text, int delayMs) {
    foreach (char c in text) {
      INPUT[] pair = new INPUT[] { KeyChar(c, false), KeyChar(c, true) };
      Emit(pair);
      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);
    }
  }

  public static void KeyDown(ushort vk) { Emit(new INPUT[] { KeyCode(vk, false) }); }
  public static void KeyUp(ushort vk)   { Emit(new INPUT[] { KeyCode(vk, true) }); }

  /** A chord: modifiers down, key, modifiers up in reverse. */
  public static void Chord(ushort[] mods, ushort key) {
    foreach (ushort m in mods) KeyDown(m);
    if (key != 0) { KeyDown(key); System.Threading.Thread.Sleep(15); KeyUp(key); }
    for (int i = mods.Length - 1; i >= 0; i--) KeyUp(mods[i]);
  }
}
'@
if (-not ('AdiInput' -as [type])) { Add-Type -TypeDefinition $sig }
`;

/** Window enumeration, position and state. */
export const WIN32 = `
$winSig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AdiWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string Title(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  /** Visible, titled top-level windows: title, pid, and where they actually are. */
  public static List<string> List() {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length == 0) return true;
      RECT r;
      GetWindowRect(h, out r);
      if (r.Right - r.Left < 1 || r.Bottom - r.Top < 1) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string state = IsIconic(h) ? "min" : "";
      found.Add(h.ToInt64() + "|" + pid + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + state + "|" + t);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /**
   * Finds a window by part of its title, preferring one that is not minimized —
   * a minimized window parks at -32000 and any coordinate taken from it is
   * useless for clicking.
   */
  public static IntPtr Find(string needle) {
    IntPtr match = IntPtr.Zero;
    IntPtr fallback = IntPtr.Zero;
    string want = needle.ToLowerInvariant();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length > 0 && t.ToLowerInvariant().Contains(want)) {
        if (!IsIconic(h)) { match = h; return false; }
        if (fallback == IntPtr.Zero) fallback = h;
      }
      return true;
    }, IntPtr.Zero);
    return match != IntPtr.Zero ? match : fallback;
  }
}
'@
if (-not ('AdiWin' -as [type])) { Add-Type -TypeDefinition $winSig }

function Format-Win($line) {
  $f = $line -split '\\|', 8
  "{0,-9} pid {1,-7} at {2},{3}  {4}x{5} {6,-4} {7}" -f $f[0], $f[1], $f[2], $f[3], $f[4], $f[5], $f[6], $f[7]
}
`;

/** The endpoint volume, so a level can be set rather than nudged. */
export const AUDIO = `
$audioSig = @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int aparams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AdiAudio {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev = null; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v = null; Guid g = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref g, 23, 0, out v)); return v;
  }
  public static float Get() { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
'@
if (-not ('AdiAudio' -as [type])) { Add-Type -TypeDefinition $audioSig }
`;

/** Virtual key codes, shared by hold_key and the chord helpers. */
export const VK: Record<string, number> = {
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, win: 0x5b, meta: 0x5b,
  space: 0x20, enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, capslock: 0x14, printscreen: 0x2c,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76,
  f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5a,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
};

export const MODIFIERS = new Set(['shift', 'ctrl', 'control', 'alt', 'win', 'meta']);
