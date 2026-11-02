import { open, readdir, readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

/**
 * Reads Claude Code's own session bookkeeping to label running sessions with the chat title Claude
 * generated. These files are undocumented internals, so every field is optional and any failure
 * just means "no title" (callers fall back to the terminal name).
 *
 *   ~/.claude/sessions/<pid>.json              → { sessionId, cwd, status, … } per running CLI
 *   ~/.claude/projects/<cwd-slug>/<id>.jsonl   → transcript; `{"type":"ai-title","aiTitle":…}` entries
 */

const SessionFileSchema = z.looseObject({
  pid: z.number().int().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  /** "cli" for terminal sessions, "claude-vscode" for chats in the Claude Code extension. */
  entrypoint: z.string().optional(),
});

export interface RunningSession {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint?: string;
  status?: string;
}

/**
 * Sessions whose process is still alive (session files can outlive a crashed process), working in
 * `root` or below it.
 */
export async function listRunningSessions(root: string, alivePids: ReadonlySet<number>, claudeHome = defaultClaudeHome()): Promise<RunningSession[]> {
  const dir = path.join(claudeHome, 'sessions');
  const names = await readdir(dir).catch(() => [] as string[]);
  const sessions: RunningSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = SessionFileSchema.safeParse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
      if (!parsed.success) continue;
      const { pid, sessionId, cwd, entrypoint, status } = parsed.data;
      if (pid === undefined || !sessionId || !cwd || !alivePids.has(pid) || !isWithin(root, cwd)) continue;
      sessions.push({ pid, sessionId, cwd, entrypoint, status });
    } catch {
      // Unreadable or half-written file.
    }
  }
  return sessions;
}

/** The chat title Claude generated for a session, if it has one yet. */
export function readSessionTitle(session: Pick<RunningSession, 'sessionId' | 'cwd'>, claudeHome = defaultClaudeHome()): Promise<string | undefined> {
  return readAiTitle(path.join(claudeHome, 'projects', projectSlug(session.cwd), `${session.sessionId}.jsonl`)).catch(() => undefined);
}

function defaultClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

function isWithin(root: string, dir: string): boolean {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface ClaudeSessionInfo {
  pid: number;
  sessionId?: string;
  title?: string;
  /** e.g. "idle" / "busy", as Claude reports it. */
  status?: string;
}

/** Only the end of a transcript is read first; titles are re-appended as the chat goes on. */
const TAIL_BYTES = 512 * 1024;
const MAX_FULL_READ_BYTES = 64 * 1024 * 1024;

export async function readSessionInfo(pid: number, claudeHome = defaultClaudeHome()): Promise<ClaudeSessionInfo> {
  try {
    const parsed = SessionFileSchema.safeParse(JSON.parse(await readFile(path.join(claudeHome, 'sessions', `${pid}.json`), 'utf8')));
    if (!parsed.success) return { pid };
    const { sessionId, cwd, status } = parsed.data;
    // A new session has no transcript (or no title) yet; that shouldn't drop the status.
    const title = sessionId && cwd ? await readSessionTitle({ sessionId, cwd }, claudeHome) : undefined;
    return { pid, sessionId, status, title };
  } catch {
    return { pid };
  }
}

/** Claude's project directory name: every character outside [A-Za-z0-9-] becomes '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

export async function readAiTitle(transcript: string): Promise<string | undefined> {
  const { size } = await stat(transcript);
  const tail = await readRange(transcript, Math.max(0, size - TAIL_BYTES), size);
  return lastAiTitle(tail) ?? (size > TAIL_BYTES && size <= MAX_FULL_READ_BYTES ? lastAiTitle(await readFile(transcript, 'utf8')) : undefined);
}

/** The most recent `ai-title` in JSONL text (partial first/last lines are skipped). */
export function lastAiTitle(jsonl: string): string | undefined {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"ai-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) return entry.aiTitle.trim();
    } catch {
      // Truncated line at the start of the tail window.
    }
  }
  return undefined;
}

async function readRange(file: string, start: number, end: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
