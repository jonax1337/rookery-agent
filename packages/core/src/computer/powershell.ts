import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * One long-lived Windows PowerShell with the screen, mouse and keyboard
 * helpers compiled in. Compiling the C# once per process is what makes a
 * click cost milliseconds instead of a second; a fresh shell per action
 * would recompile every time.
 *
 * Protocol: one base64 line in, a JSON line plus an end marker out. Requests
 * are serialised, so an action never overlaps a screenshot.
 */

const END = '<<RK-END>>';

/** The C# behind the helpers: raw Win32, because .NET has no mouse of its own. */
const NATIVE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RkNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
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
  @{ left = $b.Left; top = $b.Top; width = $b.Width; height = $b.Height; screens = $screens; cursor = (Rk-Cursor) }
}

function Rk-Screenshot($maxWidth, $path) {
  $b = Rk-Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
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
    png = [Convert]::ToBase64String($bytes) }
  $bmp.Dispose()
  $result
}

function Rk-Move($x, $y) {
  Rk-Failsafe
  [RkNative]::SetCursorPos([int]$x, [int]$y) | Out-Null
  Start-Sleep -Milliseconds 30
  @{ ok = $true }
}

function Rk-Click($x, $y, $button, $count) {
  Rk-Move $x $y | Out-Null
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
  Start-Sleep -Milliseconds 120
  $steps = 20
  for ($i = 1; $i -le $steps; $i++) {
    $px = [int]($x1 + ($x2 - $x1) * $i / $steps)
    $py = [int]($y1 + ($y2 - $y1) * $i / $steps)
    [RkNative]::SetCursorPos($px, $py) | Out-Null
    Start-Sleep -Milliseconds 15
  }
  Start-Sleep -Milliseconds 120
  [RkNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  @{ ok = $true }
}

function Rk-Scroll($x, $y, $direction, $amount) {
  Rk-Move $x $y | Out-Null
  $delta = 120 * $amount
  if ($direction -eq 'down') { [RkNative]::mouse_event(0x0800, 0, 0, -$delta, [UIntPtr]::Zero) }
  elseif ($direction -eq 'up') { [RkNative]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero) }
  elseif ($direction -eq 'right') { [RkNative]::mouse_event(0x1000, 0, 0, $delta, [UIntPtr]::Zero) }
  else { [RkNative]::mouse_event(0x1000, 0, 0, -$delta, [UIntPtr]::Zero) }
  @{ ok = $true }
}

function Rk-Type($text) {
  Rk-Failsafe
  [RkNative]::TypeText($text)
  @{ ok = $true; chars = $text.Length }
}

function Rk-Keys($combos) {
  Rk-Failsafe
  foreach ($combo in $combos) {
    [RkNative]::Combo([int[]]$combo)
    Start-Sleep -Milliseconds 60
  }
  @{ ok = $true }
}

function Rk-Windows {
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
  @{ ok = $ok; title = $matchTitle }
}

function Rk-Open($target) {
  Start-Process $target
  Start-Sleep -Milliseconds 400
  @{ ok = $true }
}

function Rk-ClipGet { @{ text = [string](Get-Clipboard -Raw) } }
function Rk-ClipSet($text) { Set-Clipboard -Value $text; @{ ok = $true } }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
  try {
    $out = Invoke-Expression $script
    $json = ConvertTo-Json -InputObject $out -Compress -Depth 5
    [Console]::Out.WriteLine($json)
  } catch {
    $err = @{ error = $_.Exception.Message }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $err -Compress))
  }
  [Console]::Out.WriteLine('${END}')
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

  /** Spawn the shell with the prelude loaded; the first call waits for the compile. */
  start(): void {
    if (this.#child) return;
    const encoded = Buffer.from(PRELUDE, 'utf16le').toString('base64');
    const child = spawn(
      powershellBinary(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => this.#lines?.(line));
    child.on('exit', () => {
      this.#child = null;
    });
    this.#child = child;
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
    return new Promise<T>((resolve, reject) => {
      const chunks: string[] = [];
      const finish = (): void => {
        clearTimeout(timer);
        child.off('exit', onExit);
        this.#lines = null;
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('The action timed out after ' + Math.round(timeoutMs / 1000) + ' s.' + this.#tail()));
      }, timeoutMs);
      const onExit = (): void => {
        finish();
        reject(new Error('PowerShell exited.' + this.#tail()));
      };
      child.once('exit', onExit);
      this.#lines = (line) => {
        if (line !== END) {
          chunks.push(line);
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
      child.stdin!.write(Buffer.from(expression, 'utf8').toString('base64') + '\n');
    });
  }

  #tail(): string {
    return this.#stderr.trim() ? '\n' + this.#stderr.trim().slice(-600) : '';
  }

  close(): void {
    this.#child?.stdin?.end();
    this.#child?.kill();
    this.#child = null;
  }
}
