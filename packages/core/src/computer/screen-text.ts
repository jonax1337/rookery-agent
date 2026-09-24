/**
 * Reading the screen as text, waiting for it to settle, and handing over to
 * the user.
 *
 * Text is how a model finds things fastest: "click Save" needs no pixel
 * reasoning, and a page of OCR lines costs a fraction of an image. Windows
 * ships the recogniser (Windows.Media.Ocr), so this works in every app,
 * canvases and games included, with no download.
 */

/** A recognised word: text, then its box in physical pixels. */
export type Word = [text: string, x: number, y: number, width: number, height: number];

export interface ScreenText {
  /** Lines of words, in the recogniser's reading order. */
  lines: Word[][];
  left: number;
  top: number;
  width: number;
  height: number;
  foreground: number;
  active: WindowInfo;
  /** The foreground window as [left, top, right, bottom]. */
  window: [number, number, number, number];
}

/** A top-level window as the worker names it. */
export interface WindowInfo {
  handle: number;
  title: string;
  process: string;
}

/** What Rk-Settle reports after an action: how long the screen took to come to rest and what is in front now. */
export interface SettleResult {
  ms: number;
  /** Anything beyond a caret blink changed while waiting. */
  changed: boolean;
  active: WindowInfo;
  /** A different window came to the front during the action. */
  foregroundChanged: boolean;
}

/** One line for the model about a window: its title, program and handle. */
export function describeWindow(info: WindowInfo): string {
  return JSON.stringify(info.title) + ' (' + (info.process || 'unknown') + ', window=' + info.handle + ')';
}

/** What an action's settle tells the model, in one line. */
export function describeSettle(result: SettleResult): string {
  return (result.changed ? 'Screen settled after ' + result.ms + ' ms.' : 'Nothing visible changed on screen (' + result.ms + ' ms).') +
    (result.foregroundChanged ? ' Active window is now ' + describeWindow(result.active) + '.' : '');
}

export interface TextMatch {
  /** What the screen actually says there. */
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** An OCR near-miss ("Speichem" for "Speichern") rather than an exact hit. */
  approximate: boolean;
  /** Starts and ends on word boundaries: "Save" in "Save as", not in "Saved". */
  whole: boolean;
  /** Inside the foreground window, where a click is most likely meant. */
  foreground: boolean;
}

const normal = (text: string): string => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Edit distance, bounded: anything above limit is reported as limit + 1. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]!);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

function box(words: Word[]): Pick<TextMatch, 'x' | 'y' | 'width' | 'height'> {
  const left = Math.min(...words.map((w) => w[1])), top = Math.min(...words.map((w) => w[2]));
  const right = Math.max(...words.map((w) => w[1] + w[3])), bottom = Math.max(...words.map((w) => w[2] + w[4]));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Where a phrase is on screen, in physical pixels. Exact (case-insensitive)
 * hits first; only if there are none, near-misses within about one wrong
 * letter in four, because OCR confuses rn and m, l and I. Whole-word matches
 * rank first, then those inside the foreground window, then top to bottom.
 */
export function findText(screen: ScreenText, phrase: string): TextMatch[] {
  const needle = normal(phrase);
  const needleWords = needle.split(' ').length;
  const [wl, wt, wr, wb] = screen.window;
  const inForeground = (m: { x: number; y: number; width: number; height: number }): boolean => {
    const cx = m.x + m.width / 2, cy = m.y + m.height / 2;
    return cx >= wl && cx <= wr && cy >= wt && cy <= wb;
  };
  const exact: TextMatch[] = [];
  const near: TextMatch[] = [];
  // About one wrong letter in four ("rn" read as "m" is two), none for short words, where a near-miss is a different word.
  const limit = needle.length <= 3 ? 0 : Math.max(1, Math.round(needle.length / 4));
  for (const line of screen.lines) {
    // The line as one string, remembering where each word starts, so a phrase can span words.
    let joined = '';
    const starts: number[] = [];
    for (const word of line) {
      if (joined) joined += ' ';
      starts.push(joined.length);
      joined += normal(word[0]);
    }
    for (let at = joined.indexOf(needle); at >= 0; at = joined.indexOf(needle, at + 1)) {
      const words = line.filter((word, i) => starts[i]! < at + needle.length && starts[i]! + normal(word[0]).length > at);
      const end = at + needle.length;
      const whole = starts.includes(at) && line.some((word, i) => starts[i]! + normal(word[0]).length === end);
      const found = { text: words.map((w) => w[0]).join(' '), ...box(words), approximate: false, whole, foreground: false };
      exact.push({ ...found, foreground: inForeground(found) });
    }
    if (exact.length) continue;
    for (let i = 0; i + needleWords <= line.length; i++) {
      const words = line.slice(i, i + needleWords);
      const text = normal(words.map((w) => w[0]).join(' '));
      if (distance(text, needle, limit) <= limit) {
        const found = { text: words.map((w) => w[0]).join(' '), ...box(words), approximate: true, whole: true, foreground: false };
        near.push({ ...found, foreground: inForeground(found) });
      }
    }
  }
  const order = (a: TextMatch, b: TextMatch): number =>
    Number(b.whole) - Number(a.whole) || Number(b.foreground) - Number(a.foreground) || a.y - b.y || a.x - b.x;
  return (exact.length ? exact : near).sort(order);
}

/**
 * The one match a click by text should take, or why there is none: an
 * explicit index, else the only whole-word match, else the only one in the
 * active window. Anything more ambiguous is the model's call, not a guess.
 */
export function pickMatch(matches: TextMatch[], phrase: string, index?: number): TextMatch | string {
  if (!matches.length) return 'No text "' + phrase + '" on screen.';
  if (index !== undefined) return matches[index - 1] ?? 'Only ' + matches.length + ' matches for "' + phrase + '".';
  const whole = matches.filter((m) => m.whole);
  const candidates = whole.length ? whole : matches;
  if (candidates.length === 1) return candidates[0]!;
  const inFront = candidates.filter((m) => m.foreground);
  if (inFront.length === 1) return inFront[0]!;
  return candidates.length + ' places say "' + phrase + '"; pass index.';
}

/**
 * The screen as text lines with their centres in screenshot pixels, in
 * reading order. OCR splits a row into several lines whose centres differ by
 * a pixel or two; those are ordered left to right, not by that jitter.
 */
export function describeScreen(screen: ScreenText, scale: number, limit = 300, origin: { left: number; top: number } = screen): string {
  const lines = screen.lines.filter((line) => line.length).map((line) => {
    const b = box(line);
    return { b, text: line.map((word) => word[0]).join(' ') };
  }).sort((a, b) => (a.b.y + a.b.height / 2) - (b.b.y + b.b.height / 2));
  if (!lines.length) return '(no text recognised on screen)';
  const rows: (typeof lines)[] = [];
  let bottom = -Infinity;
  for (const line of lines) {
    const middle = line.b.y + line.b.height / 2;
    // A line whose middle sits inside the current row's band belongs to that row.
    if (middle < bottom) rows.at(-1)!.push(line);
    else {
      rows.push([line]);
      bottom = line.b.y + line.b.height;
    }
  }
  const ordered = rows.flatMap((row) => row.sort((a, b) => a.b.x - b.b.x));
  return ordered.slice(0, limit).map(({ b, text }) =>
    Math.round((b.x + b.width / 2 - origin.left) * scale) + ',' + Math.round((b.y + b.height / 2 - origin.top) * scale) + ' ' + text,
  ).join('\n') + (ordered.length > limit ? '\n... ' + (ordered.length - limit) + ' more lines' : '');
}

/* ------------------------------ worker side ------------------------------- */

export const SECURE_PROMPT =
  'A secure Windows prompt (UAC consent, Windows Hello, sign-in or the lock screen) has the screen. ' +
  'Software cannot see or answer it, by design. Call hand_over so the user can.';

/** PowerShell: settle, OCR and hand-over, loaded into the worker. */
export const SCREEN_TEXT = `
$script:rkSecurePrompt = '${SECURE_PROMPT.replace(/'/g, "''")}'

# Every action ends here: wait for the screen to stop changing, then record
# what is in front so the next action's guard measures against it.
function Rk-Settle($min = 120, $max = 2000, $quiet = 150) {
  $b = Rk-Bounds
  $before = $script:rkForeground
  $r = [RkNative]::Settle($b.Left, $b.Top, $b.Width, $b.Height, $min, $max, $quiet)
  Rk-Seen
  $fg = $script:rkForeground
  @{ ms = $r[0]; changed = ($r[1] -eq 1); active = (Rk-WindowInfo $fg); foregroundChanged = ($null -ne $before -and $before -ne $fg) }
}

$script:rkOcr = $null
function Rk-OcrEngine {
  if ($null -ne $script:rkOcr) { return $script:rkOcr }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $script:rkAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  } | Select-Object -First 1
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'Windows has no text recognition language installed (Settings > Time & language > Language > Optical character recognition).' }
  $script:rkOcr = $engine
  $engine
}

function Rk-Await($operation, [Type]$type) {
  $task = $script:rkAsTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}

# The whole desktop as recognised words, boxes in physical pixels.
function Rk-ReadScreen($observe = $true) {
  if ([RkNative]::SecureDesktop()) { throw $script:rkSecurePrompt }
  $engine = Rk-OcrEngine
  $fgBefore = [RkNative]::GetForegroundWindow()
  $b = Rk-Bounds
  $scale = [Math]::Min(1.0, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [double][Math]::Max($b.Width, $b.Height))
  $w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  Rk-CursorCapture $true
  try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size) } finally { Rk-CursorCapture $false; $g.Dispose() }
  if ($observe) { Rk-CursorStatus 'Reading' }
  if ($scale -lt 1) {
    $small = New-Object System.Drawing.Bitmap $w, $h
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.DrawImage($bmp, 0, 0, $w, $h); $sg.Dispose(); $bmp.Dispose(); $bmp = $small
  }
  $stream = New-Object System.IO.MemoryStream
  try {
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $stream.Position = 0
    $decoder = Rk-Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream))) ([Windows.Graphics.Imaging.BitmapDecoder])
    $image = Rk-Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Rk-Await ($engine.RecognizeAsync($image)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose(); $bmp.Dispose() }
  $lines = @(foreach ($line in $result.Lines) {
    ,@(foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      ,@($word.Text, [int]($b.Left + $r.X / $scale), [int]($b.Top + $r.Y / $scale), [int]($r.Width / $scale), [int]($r.Height / $scale))
    })
  })
  $fg = [RkNative]::GetForegroundWindow()
  if ($fg -ne $fgBefore) { throw 'The active window changed while reading the screen. Read it again.' }
  Rk-Seen
  $wr = New-Object RkNative+RECT
  [RkNative]::GetWindowRect($fg, [ref]$wr) | Out-Null
  @{ lines = $lines; left = $b.Left; top = $b.Top; width = $b.Width; height = $b.Height; foreground = [long]$fg; active = (Rk-WindowInfo $fg); window = @($wr.Left, $wr.Top, $wr.Right, $wr.Bottom) }
}

# Wait for the user to do what software must not: a secure prompt closing, or
# their own input followed by a few seconds of quiet. The agent sends nothing
# meanwhile, so any input Windows counts is the user's.
function Rk-HandOver($reason, $timeoutMs) {
  $label = 'Your turn · ' + $reason
  if (-not [RkNative]::SecureDesktop()) {
    $p = Rk-Cursor
    Rk-ShowPointer 0 $p.x $p.y $label $true | Out-Null
  }
  [System.Media.SystemSounds]::Asterisk.Play()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $secureSeen = $false; $touched = $false
  $outcome = 'Timed out; the user did not act.'
  while ($clock.ElapsedMilliseconds -lt $timeoutMs) {
    Start-Sleep -Milliseconds 150
    if ([RkNative]::SecureDesktop()) { $secureSeen = $true; continue }
    if ($secureSeen) { $outcome = 'The secure prompt closed.'; break }
    $idle = [RkNative]::IdleMs()
    if ($idle -lt $clock.ElapsedMilliseconds) { $touched = $true }
    if ($touched -and $idle -ge 4000) { $outcome = 'The user acted and has been idle for 4 s.'; break }
  }
  # Whatever the user left in front is the new baseline.
  if (-not [RkNative]::SecureDesktop()) { Rk-Seen }
  @{ outcome = $outcome; waitedMs = $clock.ElapsedMilliseconds }
}
`;
