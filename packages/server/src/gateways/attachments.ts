import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayAttachment } from '@rookery/core';

/**
 * Where a file from the phone lands so a turn can actually open it.
 *
 * The provider CLIs read images and documents from disk - that is the whole
 * mechanism behind "the assistant can see the photo". What they cannot do is
 * reach outside the directory they were started in, and the assistant is
 * always started in the workspace. So an attachment goes *into* the
 * workspace, under `inbox/telegram/<date>/`, and the turn is handed the
 * absolute path.
 *
 * That makes the inbox a real folder a person will open one day, which
 * settles the rest of the shape: one folder per day, names that say what
 * they are and when they arrived, nothing from the sender in the file name,
 * and a sweep that keeps the folder from becoming an archive nobody asked
 * for.
 */

/** How long a saved attachment stays before the next sweep removes it. */
const KEEP_DAYS = 30;

/** Extension per kind, when neither the name nor the mime type offers one. */
const FALLBACK_EXTENSION: Record<GatewayAttachment['kind'], string> = {
  photo: 'jpg',
  voice: 'ogg',
  audio: 'mp3',
  video: 'mp4',
  video_note: 'mp4',
  animation: 'mp4',
  document: 'bin',
  sticker: 'webp',
};

/** Mime types worth trusting for an extension; the rest fall back by kind. */
const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
};

export interface SavedAttachment {
  /** Absolute path, which is what the turn is told. */
  path: string;
  /** Path relative to the workspace, which is what a log line shows. */
  relative: string;
  bytes: number;
}

/** The root of the Telegram inbox inside a workspace. */
export function inboxDir(workspace: string): string {
  return join(workspace, 'inbox', 'telegram');
}

function twoDigits(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

/**
 * An extension for the saved file. Only ever derived - never taken from the
 * sender's file name as-is, which is foreign text that ends up in a path.
 */
function extensionOf(attachment: GatewayAttachment): string {
  const named = /\.([A-Za-z0-9]{1,6})$/.exec(attachment.fileName ?? '')?.[1];
  if (named && /^[A-Za-z0-9]+$/.test(named)) return named.toLowerCase();
  const mime = attachment.mime?.toLowerCase().split(';')[0]?.trim();
  if (mime && MIME_EXTENSION[mime]) return MIME_EXTENSION[mime];
  if (mime?.startsWith('image/')) return 'jpg';
  return FALLBACK_EXTENSION[attachment.kind] ?? 'bin';
}

/**
 * The sender's own name for the file, reduced to something printable.
 *
 * Kept because "invoice-2026.pdf" tells the assistant more than "document"
 * does, and stripped the moment it contains anything that could steer a
 * path: separators, dots that could walk up, control characters. What
 * survives is letters, digits, dash and underscore.
 */
function safeStem(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const withoutExtension = fileName.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const clean = withoutExtension.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return clean.length >= 2 ? clean.toLowerCase() : undefined;
}

/**
 * Write one downloaded attachment into the workspace inbox.
 *
 * The name carries the time and the kind, so a folder listing reads as a
 * timeline, and ends in the file's unique id, so the same photo sent twice
 * does not overwrite itself and two files in the same second cannot collide.
 */
export function saveAttachment(
  workspace: string,
  attachment: GatewayAttachment,
  bytes: Buffer,
  now = new Date(),
): SavedAttachment {
  const day = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
  const folder = join(inboxDir(workspace), day);
  mkdirSync(folder, { recursive: true });

  const stem = safeStem(attachment.fileName);
  const unique = (attachment.uniqueId ?? attachment.fileId).replace(/[^A-Za-z0-9_-]/g, '').slice(-8) || 'file';
  const name = `${time}-${attachment.kind}${stem ? '-' + stem : ''}-${unique}.${extensionOf(attachment)}`;
  const path = join(folder, name);
  writeFileSync(path, bytes);
  return { path, relative: join('inbox', 'telegram', day, name), bytes: bytes.length };
}

/**
 * Drop day folders older than `keepDays`.
 *
 * Best-effort by design: a file held open by something else, or a folder a
 * person renamed, must not be able to stop the gateway from starting. The
 * date is read off the folder name rather than the file system, because a
 * copied workspace carries new timestamps and old contents.
 */
export function pruneInbox(workspace: string, keepDays = KEEP_DAYS, now = Date.now()): number {
  const root = inboxDir(workspace);
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const day = Date.parse(entry + 'T23:59:59');
    if (!Number.isFinite(day) || day >= cutoff) continue;
    try {
      const folder = join(root, entry);
      if (!statSync(folder).isDirectory()) continue;
      rmSync(folder, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Nothing here is worth failing a start over.
    }
  }
  return removed;
}

/** Bytes as a phone would show them, for the line the turn is handed. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** "0:42" out of seconds, for a voice note's length. */
export function humanDuration(seconds?: number): string {
  if (!seconds || seconds < 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes + ':' + (rest < 10 ? '0' + rest : String(rest));
}
