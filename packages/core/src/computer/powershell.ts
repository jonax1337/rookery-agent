import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ACCESSIBILITY } from './accessibility.js';
import { ASSEMBLY_LOADER, compiledSource, writeSource } from './assemblies.js';
import { SCREEN_TEXT } from './screen-text.js';
import { OVERLAY, OVERLAY_FILES, WINDOWS_CURSOR } from './windows-cursor.js';

/**
 * One long-lived Windows PowerShell with the screen, mouse and keyboard
 * helpers compiled in. Compiling the C# once per process is what makes a
 * click cost milliseconds instead of a second; a fresh shell per action
 * would recompile every time.
 *
 * Protocol: one base64 line in, a JSON line plus an end marker out. The
 * marker carries the request's id, so the tail of an action that timed out
 * can never be read as the answer to a later one. Requests are serialised,
 * so an action never overlaps a screenshot.
 */

const END_PREFIX = '<<RK-END:';

/** The request id an end-marker line carries, or null for a data line. */
function endMarkerId(line: string): number | null {
  if (!line.startsWith(END_PREFIX) || !line.endsWith('>>')) return null;
  const id = Number(line.slice(END_PREFIX.length, -2));
  return Number.isInteger(id) ? id : null;
}

/** The C# behind the helpers: raw Win32, because .NET has no mouse of its own. */
const NATIVE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RkNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint message, IntPtr wparam, string lparam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int w, int h, uint step, IntPtr brush, uint flags);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pos; }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public uint xHotspot; public uint yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  // Text goes in as Unicode key events, so umlauts and symbols arrive whatever the layout.
  // Sent in short batches: one SendInput per character with a sleep cost ~15 ms each.
  public static void TypeText(string text) {
    var batch = new System.Collections.Generic.List<INPUT>();
    int sent = 0;
    foreach (char c in text) {
      if (c == '\\r') continue;
      if (c == '\\n') { batch.Add(Key(0x0D, 0, 0)); batch.Add(Key(0x0D, 0, 2)); }
      else { batch.Add(Key(0, c, 0x0004)); batch.Add(Key(0, c, 0x0004 | 0x0002)); }
      if (batch.Count >= 32) { sent += Send(batch, sent); System.Threading.Thread.Sleep(1); }
    }
    Send(batch, sent);
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT(); input.type = 1;
    input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags;
    return input;
  }
  static int Send(System.Collections.Generic.List<INPUT> batch, int sent) {
    if (batch.Count == 0) return 0;
    INPUT[] inputs = batch.ToArray();
    batch.Clear();
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new InvalidOperationException("Typing was blocked after about " + sent / 2 + " characters (the target may run elevated). Check the field before retrying.");
    return inputs.Length;
  }
  // Navigation, Win and media keys carry the E0 prefix; without it Windows reads them as the
  // numpad twin, and with NumLock on shift+arrow stops selecting.
  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D ||
      vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5 || (vk >= 0xAD && vk <= 0xB3);
  }
  static void KeyEvent(int vk, bool up) {
    var input = new[] { Key((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), (up ? 0x0002u : 0u) | (Extended(vk) ? 0x0001u : 0u)) };
    if (SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("Windows refused the key input (the target may run elevated). Check the window before retrying.");
  }
  // Held in order, released in reverse; whatever went down comes back up even if a press fails.
  public static void Combo(int[] keys) {
    int down = 0;
    try {
      foreach (int k in keys) { KeyEvent(k, false); down++; System.Threading.Thread.Sleep(15); }
    } finally {
      for (int i = down - 1; i >= 0; i--) { KeyEvent(keys[i], true); if (i > 0) System.Threading.Thread.Sleep(15); }
    }
  }
  // Release buttons and modifiers a killed worker left down; only what is actually held.
  public static string[] Release() {
    var released = new System.Collections.Generic.List<string>();
    int[][] buttons = { new[] { 0x01, 0x0004 }, new[] { 0x02, 0x0010 }, new[] { 0x04, 0x0040 } };
    string[] buttonNames = { "left button", "right button", "middle button" };
    for (int i = 0; i < buttons.Length; i++)
      if ((GetAsyncKeyState(buttons[i][0]) & 0x8000) != 0) { mouse_event((uint)buttons[i][1], 0, 0, 0, UIntPtr.Zero); released.Add(buttonNames[i]); }
    int[] keys = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    string[] keyNames = { "shift", "ctrl", "alt", "win", "win" };
    for (int i = 0; i < keys.Length; i++)
      if ((GetAsyncKeyState(keys[i]) & 0x8000) != 0) { KeyEvent(keys[i], true); released.Add(keyNames[i]); }
    return released.ToArray();
  }
  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h); if (n == 0) return "";
    StringBuilder sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1); return sb.ToString();
  }
  public static void DrawCursor(IntPtr dc, int left, int top) {
    CURSORINFO c = new CURSORINFO(); c.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    ICONINFO icon;
    if (!GetCursorInfo(ref c) || c.flags != 1 || !GetIconInfo(c.hCursor, out icon)) return;
    try { DrawIconEx(dc, c.pos.X - left - (int)icon.xHotspot, c.pos.Y - top - (int)icon.yHotspot, c.hCursor, 0, 0, 0, IntPtr.Zero, 3); }
    finally { if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask); if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor); }
  }
  // Standard edit controls accept WM_SETTEXT without the focus-changing UIA proxy.
  public static bool SetEditText(IntPtr h, string value) {
    if (h == IntPtr.Zero) return false;
    var name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
    string cls = name.ToString();
    if (!cls.Equals("Edit", StringComparison.OrdinalIgnoreCase) &&
        !cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) &&
        !cls.StartsWith("WindowsForms10.EDIT.", StringComparison.OrdinalIgnoreCase)) return false;
    IntPtr result;
    if (SendMessageTimeout(h, 0x000C, IntPtr.Zero, value, 2, 2000, out result) == IntPtr.Zero || result == IntPtr.Zero)
      throw new InvalidOperationException("The edit control did not accept background text. Inspect its value before retrying.");
    // WM_SETTEXT clears the modified flag; set it, so the app still asks before discarding the text.
    SendMessageTimeout(h, 0x00B9, new IntPtr(1), null, 2, 2000, out result);
    return true;
  }
  // Windows a user could act on: visible, titled, not cloaked (suspended UWP frames, other
  // virtual desktops) and not click-through overlays, which no input can reach.
  public static bool Listed(IntPtr h) {
    if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return false;
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x20) != 0 && (ex & 0x80000) != 0) return false; // WS_EX_TRANSPARENT | WS_EX_LAYERED
    int cloaked;
    return DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0 || cloaked == 0; // DWMWA_CLOAKED
  }
  public static System.Collections.Generic.List<IntPtr> Windows() {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { if (Listed(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    // Sharing the foreground thread's input state lifts the foreground lock without a key press.
    // (A synthetic Alt tap does too, but ribbon apps like Paint then show their access-key tips.)
    uint pid, me = GetCurrentThreadId(), owner = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    bool attached = owner != 0 && owner != me && AttachThreadInput(me, owner, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); }
    finally { if (attached) AttachThreadInput(me, owner, false); }
    if (GetForegroundWindow() == h) return true;
    // Fallback: Alt held only around the switch, so its release is not a lone Alt tap in the target.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    try { return SetForegroundWindow(h); } finally { keybd_event(0x12, 0, 2, UIntPtr.Zero); }
  }

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
  [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr dc, int mode);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int length, out int needed);

  /** A 160x90 thumbnail of the screen: a few milliseconds, enough to see whether anything moved. */
  static int[] Thumbnail(int left, int top, int width, int height) {
    using (var bmp = new System.Drawing.Bitmap(160, 90, System.Drawing.Imaging.PixelFormat.Format32bppRgb))
    using (var g = System.Drawing.Graphics.FromImage(bmp)) {
      IntPtr dst = g.GetHdc(), src = GetDC(IntPtr.Zero);
      try { SetStretchBltMode(dst, 3); StretchBlt(dst, 0, 0, 160, 90, src, left, top, width, height, 0x00CC0020); }
      finally { ReleaseDC(IntPtr.Zero, src); g.ReleaseHdc(dst); }
      var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, 160, 90), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
      var pixels = new int[160 * 90];
      try { Marshal.Copy(data.Scan0, pixels, 0, pixels.Length); } finally { bmp.UnlockBits(data); }
      return pixels;
    }
  }

  /**
   * Wait until the screen stops changing, instead of guessing a sleep: at
   * least minMs, then 150 ms without visible change, at most maxMs. A caret
   * or a small spinner stays under the threshold. Returns the time waited.
   */
  public static int Settle(int left, int top, int width, int height, int minMs, int maxMs) {
    var clock = System.Diagnostics.Stopwatch.StartNew();
    int[] last = Thumbnail(left, top, width, height);
    long changedAt = 0;
    while (clock.ElapsedMilliseconds < maxMs) {
      System.Threading.Thread.Sleep(30);
      int[] now = Thumbnail(left, top, width, height);
      int changed = 0;
      for (int i = 0; i < now.Length; i++) {
        int a = last[i], b = now[i];
        if (Math.Abs((a & 0xFF) - (b & 0xFF)) + Math.Abs(((a >> 8) & 0xFF) - ((b >> 8) & 0xFF)) + Math.Abs(((a >> 16) & 0xFF) - ((b >> 16) & 0xFF)) > 48) changed++;
      }
      last = now;
      // More than 0.3 % of the thumbnail is a real change, not a caret.
      if (changed > 43) changedAt = clock.ElapsedMilliseconds;
      if (clock.ElapsedMilliseconds >= minMs && clock.ElapsedMilliseconds - changedAt >= 150) break;
    }
    return (int)clock.ElapsedMilliseconds;
  }

  /**
   * Whether a secure desktop (UAC consent, sign-in, lock screen) has the
   * input. Nothing a normal process sends reaches it, by design; the agent
   * has to hand over to the user.
   */
  public static bool SecureDesktop() {
    IntPtr desk = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
    if (desk == IntPtr.Zero) return true; // Winlogon's desktop refuses ordinary processes.
    try {
      var name = new StringBuilder(64);
      int needed;
      GetUserObjectInformation(desk, 2, name, name.Capacity * 2, out needed); // UOI_NAME
      return !name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(desk); }
  }

  /**
   * End this worker once the process that owns it is gone, however it ended:
   * a hard kill at the end of a turn skips every cleanup, and the cursor
   * overlay must never outlive its turn.
   */
  public static void ExitWith(int pid) {
    System.Diagnostics.Process owner;
    try { owner = System.Diagnostics.Process.GetProcessById(pid); }
    catch (ArgumentException) { Environment.Exit(0); return; }
    var thread = new System.Threading.Thread(delegate() { owner.WaitForExit(); Environment.Exit(0); });
    thread.IsBackground = true;
    thread.Start();
  }

  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

  /** Milliseconds since the last input of any kind; while the agent sends none, that is the user's. */
  public static uint IdleMs() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref info);
    return unchecked((uint)Environment.TickCount - info.dwTime);
  }

  /** Screenshots as JPEG at the given quality: UI text stays crisp at a fifth of the PNG size. */
  public static byte[] Jpeg(System.Drawing.Bitmap image, long quality) {
    var codec = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
    using (var parameters = new System.Drawing.Imaging.EncoderParameters(1))
    using (var stream = new System.IO.MemoryStream()) {
      parameters.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      image.Save(stream, codec, parameters);
      return stream.ToArray();
    }
  }
}
`;
const NATIVE_FILES = compiledSource('native', NATIVE);

/** The PowerShell side: the helpers the Node process calls by name. */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${ASSEMBLY_LOADER}
Rk-Assembly ${psQuote(NATIVE_FILES.assembly)} ${psQuote(NATIVE_FILES.source)} 'RkNative' @('System.dll', [System.Drawing.Bitmap].Assembly.Location, [System.Windows.Forms.Form].Assembly.Location)
[RkNative]::SetProcessDPIAware() | Out-Null
if ($env:ROOKERY_COMPUTER_OWNER) { [RkNative]::ExitWith([int]$env:ROOKERY_COMPUTER_OWNER) }

function Rk-Bounds { [System.Windows.Forms.SystemInformation]::VirtualScreen }

function Rk-Cursor {
  $p = New-Object RkNative+POINT
  [RkNative]::GetCursorPos([ref]$p) | Out-Null
  @{ x = $p.X; y = $p.Y }
}

function Rk-Failsafe {
  $b = Rk-Bounds
  $c = Rk-Cursor
  if (($c.x - $b.Left) -le 2 -and ($c.y - $b.Top) -le 2) {
    throw 'Refused: the pointer is in the top-left corner, which is the emergency brake. Ask the user before continuing.'
  }
}

function Rk-ScreenInfo {
  $b = Rk-Bounds
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    @{ name = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })
  @{ left = $b.Left; top = $b.Top; width = $b.Width; height = $b.Height; screens = $screens; cursor = (Rk-Cursor); observer = (Rk-ObserverState) }
}

${WINDOWS_CURSOR}

${SCREEN_TEXT}

function Rk-Screenshot($maxWidth, $path, $handle = 0, $observe = $true) {
  if (-not $handle -and [RkNative]::SecureDesktop()) { throw $script:rkSecurePrompt }
  # A window capture never contains the overlay; a desktop capture hides it, so the
  # overlay appears only afterwards instead of flashing in, out and in again.
  if ($observe -and $handle) { Rk-CursorStatus 'Reading' }
  $b = Rk-Bounds
  if ($handle) {
    $h = Rk-Window $handle
    if ([RkNative]::IsIconic($h)) { throw 'Minimized windows cannot be captured reliably. Use snapshot for background observation.' }
    $r = New-Object RkNative+RECT
    if (-not [RkNative]::GetWindowRect($h, [ref]$r)) { throw 'Cannot read window bounds.' }
    $b = New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  }
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($handle) {
    $dc = $g.GetHdc()
    try { $captured = [RkNative]::PrintWindow($h, $dc, 2) } finally { $g.ReleaseHdc($dc) }
    if (-not $captured) { $g.Dispose(); $bmp.Dispose(); throw 'This app does not support window capture. Use snapshot.' }
    if ($script:rkPointer -and $script:rkPointer.window -eq $handle) {
      Rk-DrawPointer $g ($script:rkPointer.x - $b.Left) ($script:rkPointer.y - $b.Top)
    }
  } else {
    Rk-CursorCapture $true
    try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size) } finally { Rk-CursorCapture $false }
    $dc = $g.GetHdc()
    try { [RkNative]::DrawCursor($dc, $b.Left, $b.Top) } finally { $g.ReleaseHdc($dc) }
  }
  if ($observe -and -not $handle) {
    if ($null -eq $script:rkCursorFeedback) {
      $point = Rk-Cursor
      Rk-ShowPointer 0 $point.x $point.y 'Reading' | Out-Null
    } else { Rk-CursorStatus 'Reading' }
  }
  $g.Dispose()
  $scale = 1.0
  if ($b.Width -gt $maxWidth) {
    $scale = $maxWidth / $b.Width
    $w = [int][Math]::Round($b.Width * $scale)
    $h = [int][Math]::Round($b.Height * $scale)
    $small = New-Object System.Drawing.Bitmap $w, $h
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $w, $h)
    $sg.Dispose()
    $bmp.Dispose()
    $bmp = $small
  }
  # Every screenshot stays in the transcript and is sent again with each model request, so bytes are latency.
  $bytes = [RkNative]::Jpeg($bmp, 85)
  if ($path) { [System.IO.File]::WriteAllBytes($path, $bytes) }
  $c = Rk-Cursor
  $result = @{ width = $bmp.Width; height = $bmp.Height; scale = $scale; left = $b.Left; top = $b.Top;
    cursorX = [int](($c.x - $b.Left) * $scale); cursorY = [int](($c.y - $b.Top) * $scale);
    foreground = [long][RkNative]::GetForegroundWindow(); window = [long]$handle;
    jpeg = [Convert]::ToBase64String($bytes) }
  $bmp.Dispose()
  $result
}

function Rk-Move($x, $y) {
  Rk-Glide $x $y
  @{ ok = $true }
}

function Rk-Click($x, $y, $button, $count) {
  Rk-Move $x $y | Out-Null
  Rk-CursorPulse 'Clicking'
  $down = 0x0002; $up = 0x0004
  if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
  elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
  for ($i = 0; $i -lt $count; $i++) {
    [RkNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [RkNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 90 }
  }
  @{ ok = $true }
}

function Rk-Drag($x1, $y1, $x2, $y2) {
  Rk-Draw @(1, 2, $x1, $y1, $x2, $y2) 'left' 'Dragging'
}

function Rk-Scroll($x, $y, $direction, $amount) {
  Rk-Move $x $y | Out-Null
  Rk-CursorStatus 'Scrolling'
  $delta = 120 * $amount
  if ($direction -eq 'down') { [RkNative]::mouse_event(0x0800, 0, 0, -$delta, [UIntPtr]::Zero) }
  elseif ($direction -eq 'up') { [RkNative]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero) }
  elseif ($direction -eq 'right') { [RkNative]::mouse_event(0x1000, 0, 0, $delta, [UIntPtr]::Zero) }
  else { [RkNative]::mouse_event(0x1000, 0, 0, -$delta, [UIntPtr]::Zero) }
  @{ ok = $true }
}

function Rk-Type($text) {
  Rk-Failsafe
  Rk-InputPointer 'Typing'
  [RkNative]::TypeText($text)
  @{ ok = $true; chars = $text.Length }
}

function Rk-Keys($combos) {
  Rk-Failsafe
  Rk-InputPointer 'Keyboard'
  foreach ($combo in $combos) {
    [RkNative]::Combo([int[]]$combo)
    Start-Sleep -Milliseconds 60
  }
  @{ ok = $true }
}

function Rk-ProcessName($h) {
  $procId = [uint32]0
  [RkNative]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  try { [System.Diagnostics.Process]::GetProcessById([int]$procId).ProcessName } catch { '' }
}

# In z-order, the active window first: the order a user sees them stacked.
function Rk-Windows {
  Rk-CursorStatus 'Finding window'
  $fg = [RkNative]::GetForegroundWindow()
  $active = @(); $rest = @()
  foreach ($h in [RkNative]::Windows()) {
    $r = New-Object RkNative+RECT
    [RkNative]::GetWindowRect($h, [ref]$r) | Out-Null
    $row = @{ handle = [int64]$h; title = [RkNative]::Title($h); process = (Rk-ProcessName $h); active = ($h -eq $fg);
      minimized = [RkNative]::IsIconic($h); x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    if ($row.active) { $active += $row } else { $rest += $row }
  }
  ,@($active + $rest)
}

# By exact handle, or best match, not the first: the exact program name, then a title
# that ends with the name (Windows apps title windows "Document - App"), then any title
# containing it. Otherwise "Paint" finds a chat window that mentions Paint.
function Rk-Focus($needle, $handle = 0) {
  $match = $null
  if ($handle) {
    $match = Rk-Window $handle
  } else {
    $needle = $needle.ToLowerInvariant()
    $best = 0
    foreach ($h in [RkNative]::Windows()) {
      $lower = [RkNative]::Title($h).ToLowerInvariant()
      $proc = (Rk-ProcessName $h).ToLowerInvariant()
      $score = 0
      if ($proc -eq $needle) { $score = 3 }
      elseif ($lower -eq $needle -or $lower.EndsWith(' - ' + $needle) -or $lower.EndsWith(' – ' + $needle)) { $score = 2 }
      elseif ($lower.Contains($needle)) { $score = 1 }
      if ($score -gt $best) { $best = $score; $match = $h }
    }
    if ($null -eq $match) { throw "No window matches '$needle'. Call list_windows." }
  }
  $title = [RkNative]::Title($match)
  [RkNative]::Focus($match) | Out-Null
  Start-Sleep -Milliseconds 150
  if ([RkNative]::GetForegroundWindow() -ne $match) {
    throw ('Windows kept "' + [RkNative]::Title([RkNative]::GetForegroundWindow()) + '" in front; "' + $title + '" did not come forward.')
  }
  Rk-InputPointer 'Ready'
  @{ title = $title; handle = [long]$match }
}

# After a worker died mid-action: let go of whatever it held down.
function Rk-Release { @{ released = @([RkNative]::Release()) } }

function Rk-Open($target) {
  Start-Process $target
  Start-Sleep -Milliseconds 400
  @{ ok = $true }
}

function Rk-ClipGet { @{ text = [string](Get-Clipboard -Raw) } }
function Rk-ClipSet($text) { Set-Clipboard -Value $text; @{ ok = $true } }

${ACCESSIBILITY}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
  # The script sets $rkId first; the marker echoes it back so a late reply
  # can never be mistaken for a newer request's answer.
  $rkId = 0
  try {
    $out = Invoke-Expression $script
    $json = ConvertTo-Json -InputObject $out -Compress -Depth 10
    [Console]::Out.WriteLine($json)
  } catch {
    $err = @{ error = $_.Exception.Message }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $err -Compress))
  } finally {
    try { Rk-CursorDone } catch { } # Visual completion must not corrupt the tool reply.
  }
  [Console]::Out.WriteLine(('<<RK-END:' + $rkId + '>>'))
  [Console]::Out.Flush()
}
`;

/** Quote a string for a PowerShell single-quoted literal. */
export function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Where the shell is: Windows PowerShell, because its .NET has WinForms without extras. */
export function powershellBinary(): string {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  return system + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

export class PowerShellSession {
  #child: ChildProcess | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lines: ((line: string) => void) | null = null;
  #stderr = '';
  #requestId = 0;

  /** Spawn the shell with the prelude loaded; the first call waits for the compile. */
  start(): void {
    if (this.#child) return;
    // The worker compiles these files; see assemblies.ts for why they are not inline.
    writeSource(NATIVE_FILES, NATIVE);
    writeSource(OVERLAY_FILES, OVERLAY);
    const child = spawn(
      powershellBinary(),
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ROOKERY_COMPUTER_OWNER: String(process.pid) },
      },
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => { if (this.#child === child) this.#lines?.(line); });
    // Send the prelude over stdin: encoded command lines hit Windows' 32K limit.
    child.stdin!.on('error', () => undefined);
    child.on('error', (error) => { this.#stderr = error.message; });
    child.on('exit', () => {
      // Only forget this child; a dying shell replaced after a timeout must
      // not null out the fresh one that already took its place.
      if (this.#child === child) this.#child = null;
    });
    this.#child = child;
    child.stdin!.write(Buffer.from(PRELUDE, 'utf8').toString('base64') + '\n');
  }

  /** Whether a worker is alive; a call on a stopped session would start a fresh one. */
  get running(): boolean {
    return this.#child !== null;
  }

  /** Evaluate one expression and parse the JSON it prints. Calls are serialised. */
  run<T = Record<string, unknown>>(expression: string, timeoutMs = 30_000): Promise<T> {
    const task = this.#queue.then(() => this.#exec<T>(expression, timeoutMs));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  #exec<T>(expression: string, timeoutMs: number): Promise<T> {
    this.start();
    const child = this.#child;
    if (!child?.stdin) return Promise.reject(new Error('PowerShell is not running.' + this.#tail()));
    const id = ++this.#requestId;
    return new Promise<T>((resolve, reject) => {
      const chunks: string[] = [];
      const finish = (): void => {
        clearTimeout(timer);
        child.off('exit', onExit);
        this.#lines = null;
      };
      const timer = setTimeout(() => {
        finish();
        // Left alone the shell would finish the action anyway, and whatever
        // it prints after this belongs to no request anymore.
        this.#kill(child);
        reject(new Error('The action timed out after ' + Math.round(timeoutMs / 1000) + ' s.' + this.#tail()));
      }, timeoutMs);
      const onExit = (): void => {
        finish();
        reject(new Error('PowerShell exited.' + this.#tail()));
      };
      child.once('exit', onExit);
      this.#lines = (line) => {
        const marker = endMarkerId(line);
        if (marker === null) {
          chunks.push(line);
          return;
        }
        // A foreign marker is the tail of an earlier request whose reply
        // arrived late; the lines collected so far are its, not this one's.
        if (marker !== id) {
          chunks.length = 0;
          return;
        }
        finish();
        const text = chunks.join('\n').trim();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error('Unreadable reply from PowerShell: ' + text.slice(0, 200)));
          return;
        }
        const error = (parsed as { error?: string }).error;
        if (error) reject(new Error(error));
        else resolve(parsed as T);
      };
      child.stdin!.write(Buffer.from('$rkId = ' + id + '; ' + expression, 'utf8').toString('base64') + '\n');
    });
  }

  #tail(): string {
    return this.#stderr.trim() ? '\n' + this.#stderr.trim().slice(-600) : '';
  }

  /** Stop the worker, preserving user apps launched with the open tool. */
  #kill(child: ChildProcess): void {
    if (this.#child === child) this.#child = null;
    child.kill('SIGKILL');
  }

  close(): void {
    this.#child?.stdin?.end();
    this.#child?.kill();
    this.#child = null;
  }
}
