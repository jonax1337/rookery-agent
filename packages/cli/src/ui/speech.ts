/**
 * Optional OS text-to-speech.
 *
 * This module is deliberately isolated and never throws: every failure path
 * returns `{ ok: false, detail }` so a missing speech engine degrades to a
 * printed notice instead of taking the REPL down with it.
 *
 *   Windows  - PowerShell + System.Speech.Synthesis.SpeechSynthesizer
 *   macOS    - `say`
 *   Linux    - `spd-say` (speech-dispatcher), then `espeak-ng` / `espeak`
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { toSpeakableText } from '@rookery/core';

export interface SpeakOptions {
  /** BCP-47 tag, e.g. `de-DE`. */
  lang?: string;
  /** 0.5 (slow) .. 2 (fast), 1 is normal. */
  rate?: number;
  /** Engine-specific voice name; empty picks the best local match. */
  voiceName?: string;
  signal?: AbortSignal;
}

export interface SpeakResult {
  ok: boolean;
  detail?: string;
}

interface Backend {
  kind: 'powershell' | 'say' | 'spd-say' | 'espeak';
  command: string;
}

const SPEAK_TIMEOUT_MS = 90_000;

let detected: Backend | null | undefined;
let current: ChildProcess | null = null;

/** Resolve (and cache) the speech backend for this machine. */
export async function detectSpeechBackend(): Promise<Backend | null> {
  if (detected !== undefined) return detected;

  const candidates: Backend[] =
    process.platform === 'win32'
      ? [
          { kind: 'powershell', command: 'powershell.exe' },
          { kind: 'powershell', command: 'pwsh' },
        ]
      : process.platform === 'darwin'
        ? [{ kind: 'say', command: 'say' }]
        : [
            { kind: 'spd-say', command: 'spd-say' },
            { kind: 'espeak', command: 'espeak-ng' },
            { kind: 'espeak', command: 'espeak' },
          ];

  for (const candidate of candidates) {
    if (await commandExists(candidate.command)) {
      detected = candidate;
      return detected;
    }
  }

  detected = null;
  return detected;
}

/** Human-readable one-liner for `/voice` and `doctor`. */
export async function describeSpeech(): Promise<string> {
  const backend = await detectSpeechBackend();
  return backend ? backend.kind + ' (' + backend.command + ')' : 'unavailable on this system';
}

/** Stop whatever is being spoken right now. Safe to call at any time. */
export function stopSpeaking(): void {
  if (!current) return;
  try {
    current.kill();
  } catch {
    /* the process was already gone */
  }
  current = null;
}

/**
 * Speak `markdown` aloud. Resolves once playback finished (or failed).
 * Markdown is normalised through core's `toSpeakableText` first so code
 * blocks and links are not read out character by character.
 */
export async function speak(markdown: string, options: SpeakOptions = {}): Promise<SpeakResult> {
  const text = toSpeakableText(markdown).trim();
  if (!text) return { ok: true };

  let backend: Backend | null = null;
  try {
    backend = await detectSpeechBackend();
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
  if (!backend) {
    return {
      ok: false,
      detail:
        process.platform === 'linux'
          ? 'No speech engine found. Install speech-dispatcher (spd-say) or espeak-ng.'
          : 'No speech engine found on this system.',
    };
  }

  stopSpeaking();

  try {
    return await run(backend, text, options);
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/* --------------------------------------------------------------------- */

function run(backend: Backend, text: string, options: SpeakOptions): Promise<SpeakResult> {
  const lang = options.lang ?? '';
  const voice = options.voiceName ?? '';
  const rate = clampRate(options.rate ?? 1);

  let args: string[] = [];
  let env: NodeJS.ProcessEnv = process.env;
  let stdinText: string | null = null;

  switch (backend.kind) {
    case 'powershell': {
      // The text travels through the environment, never through the command
      // line, so quotes and newlines in a reply can never become script.
      env = {
        ...process.env,
        ROOKERY_SPEECH_TEXT: text,
        ROOKERY_SPEECH_RATE: String(Math.round((rate - 1) * 10)),
        ROOKERY_SPEECH_VOICE: voice,
        ROOKERY_SPEECH_LANG: lang,
      };
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT];
      break;
    }
    case 'say': {
      args = [];
      if (voice) args.push('-v', voice);
      // `say` wants words per minute; 175 is roughly its default.
      args.push('-r', String(Math.round(175 * rate)));
      args.push('-f', '-');
      stdinText = text;
      break;
    }
    case 'spd-say': {
      args = ['-w'];
      if (lang) args.push('-l', lang.split('-')[0] ?? lang);
      if (voice) args.push('-y', voice);
      args.push('-r', String(clampInt(Math.round((rate - 1) * 50), -100, 100)));
      args.push('--', text);
      break;
    }
    case 'espeak': {
      args = [];
      if (lang) args.push('-v', lang.toLowerCase());
      args.push('-s', String(clampInt(Math.round(175 * rate), 80, 450)));
      args.push('--stdin');
      stdinText = text;
      break;
    }
  }

  return new Promise<SpeakResult>((resolve) => {
    let settled = false;
    const finish = (result: SpeakResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      current = null;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(backend.command, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, detail: (error as Error).message });
      return;
    }

    current = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, detail: 'aborted' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, detail: 'speech timed out' });
    }, SPEAK_TIMEOUT_MS);
    timer.unref?.();

    child.on('error', (error: Error) => {
      finish({ ok: false, detail: error.message });
    });

    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, detail: (stderr.trim().split('\n')[0] ?? '') || 'exit code ' + code });
    });

    if (stdinText !== null && child.stdin) {
      child.stdin.on('error', () => {
        /* the engine closed stdin early; `close` reports the real outcome */
      });
      child.stdin.end(stdinText, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/** Speaks $env:ROOKERY_SPEECH_TEXT. Single-quoted throughout so the shell never re-parses it. */
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'try { $synth.Rate = [int]$env:ROOKERY_SPEECH_RATE } catch { }',
  "if ($env:ROOKERY_SPEECH_VOICE) { try { $synth.SelectVoice($env:ROOKERY_SPEECH_VOICE) } catch { } }",
  "elseif ($env:ROOKERY_SPEECH_LANG) { try { $c = New-Object System.Globalization.CultureInfo($env:ROOKERY_SPEECH_LANG); $synth.SelectVoiceByHints(0, 0, 0, $c) } catch { } }",
  '$synth.Speak($env:ROOKERY_SPEECH_TEXT)',
  '$synth.Dispose()',
].join('; ');

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    let child: ChildProcess;
    try {
      child = spawn(probe, [command], { stdio: 'ignore', shell: false });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(false);
    }, 4000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, rate));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
