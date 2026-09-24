import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ACCESSIBILITY } from './accessibility.js';
import { WINDOWS_CURSOR } from './windows-cursor.js';

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
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
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
  public static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\\r') continue;
      if (c == '\\n') { Tap(0x0D); continue; }
      INPUT[] pair = new INPUT[2];
      pair[0].type = 1; pair[0].u.ki.wScan = (ushort)c; pair[0].u.ki.dwFlags = 0x0004;
      pair[1].type = 1; pair[1].u.ki.wScan = (ushort)c; pair[1].u.ki.dwFlags = 0x0004 | 0x0002;
      SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(4);
    }
  }
  public static void Tap(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static void Combo(int[] keys) {
    foreach (int k in keys) { keybd_event((byte)k, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(15); }
    for (int i = keys.Length - 1; i >= 0; i--) { keybd_event((byte)keys[i], 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(15); }
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
    return true;
  }
  public static System.Collections.Generic.List<IntPtr> Windows() {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    // A synthetic Alt tap lifts the foreground lock so SetForegroundWindow is honoured.
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
}
`;

/** The PowerShell side: the helpers the Node process calls by name. */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${NATIVE}
'@
[RkNative]::SetProcessDPIAware() | Out-Null

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

function Rk-Screenshot($maxWidth, $path, $handle = 0, $observe = $true) {
  if ($observe) {
    if ($null -eq $script:rkCursorFeedback -and -not $handle) {
      $point = Rk-Cursor
      Rk-ShowPointer 0 $point.x $point.y 'Reading' | Out-Null
    } else { Rk-CursorStatus 'Reading' }
  }
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
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  if ($path) { [System.IO.File]::WriteAllBytes($path, $bytes) }
  $c = Rk-Cursor
  $result = @{ width = $bmp.Width; height = $bmp.Height; scale = $scale; left = $b.Left; top = $b.Top;
    cursorX = [int](($c.x - $b.Left) * $scale); cursorY = [int](($c.y - $b.Top) * $scale);
    foreground = [long][RkNative]::GetForegroundWindow(); window = [long]$handle;
    png = [Convert]::ToBase64String($bytes) }
  $bmp.Dispose()
  $result
}

function Rk-Glide($x, $y, $duration, $action = 'Moving') {
  Rk-Failsafe
  $from = Rk-Cursor
  $feedback = Rk-ShowPointer 0 $from.x $from.y $action $true
  if ($feedback.error) { throw ('Cannot show the computer-use cursor. No input sent: ' + $feedback.error) }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalMilliseconds -lt $duration) {
    Rk-Failsafe
    $t = $clock.Elapsed.TotalMilliseconds / $duration
    $ease = $t * $t * (3 - 2 * $t)
    $px = [int]($from.x + ($x - $from.x) * $ease)
    $py = [int]($from.y + ($y - $from.y) * $ease)
    [RkNative]::SetCursorPos($px, $py) | Out-Null
    Rk-ShowPointer 0 $px $py $action $true | Out-Null
    Start-Sleep -Milliseconds 8
  }
  [RkNative]::SetCursorPos([int]$x, [int]$y) | Out-Null
  $script:rkPointer = @{ window = [long][RkNative]::GetForegroundWindow(); x = $x; y = $y }
  Rk-ShowPointer 0 $x $y $action $true | Out-Null
}

function Rk-Move($x, $y) {
  $from = Rk-Cursor
  $distance = [Math]::Sqrt([Math]::Pow($x - $from.x, 2) + [Math]::Pow($y - $from.y, 2))
  $animate = $false
  [RkNative]::SystemParametersInfo(0x1042, 0, [ref]$animate, 0) | Out-Null # SPI_GETCLIENTAREAANIMATION
  $duration = if ($distance -lt 2 -or -not $animate) { 0 } else { [Math]::Min(160, [Math]::Max(70, $distance * 0.18)) }
  Rk-Glide $x $y $duration
  @{ ok = $true }
}

function Rk-Click($x, $y, $button, $count) {
  Rk-Move $x $y | Out-Null
  Rk-ShowPointer 0 $x $y 'Clicking' $true | Out-Null
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
  Rk-Move $x1 $y1 | Out-Null
  [RkNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  try {
    Rk-Glide $x2 $y2 280 'Dragging'
  } finally {
    [RkNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  @{ ok = $true }
}

function Rk-Scroll($x, $y, $direction, $amount) {
  Rk-Move $x $y | Out-Null
  Rk-ShowPointer 0 $x $y 'Scrolling' $true | Out-Null
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

function Rk-Windows {
  Rk-CursorStatus 'Finding window'
  $fg = [RkNative]::GetForegroundWindow()
  $rows = @()
  foreach ($h in [RkNative]::Windows()) {
    $r = New-Object RkNative+RECT
    [RkNative]::GetWindowRect($h, [ref]$r) | Out-Null
    $procId = [uint32]0
    [RkNative]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = ''
    try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    $rows += @{ handle = [int64]$h; title = [RkNative]::Title($h); process = $proc; active = ($h -eq $fg);
      x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
  }
  ,@($rows | Sort-Object -Property @{ Expression = { $_.active }; Descending = $true })
}

function Rk-Focus($needle) {
  $needle = $needle.ToLowerInvariant()
  $match = $null
  $matchTitle = ''
  foreach ($h in [RkNative]::Windows()) {
    $title = [RkNative]::Title($h)
    $procId = [uint32]0
    [RkNative]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = ''
    try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    if ($title.ToLowerInvariant().Contains($needle) -or $proc.ToLowerInvariant() -eq $needle) { $match = $h; $matchTitle = $title; break }
  }
  if ($null -eq $match) { throw "No window matches '$needle'." }
  $ok = [RkNative]::Focus($match)
  Start-Sleep -Milliseconds 150
  Rk-InputPointer 'Ready'
  @{ ok = $ok; title = $matchTitle }
}

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
    const child = spawn(
      powershellBinary(),
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' },
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
