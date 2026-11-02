import { appendFile, readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Append-only log of Claude turns, written by the Claude Code hook and read by the extension
 * and MCP server. One JSON object per line; appends of a single short line are atomic.
 */
const TurnEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    turnId: z.string(),
    sessionId: z.string(),
    prompt: z.string(),
    ref: z.string(),
    at: z.string(),
    /** The Claude CLI process that ran the turn, used to label sessions when sending comments. */
    claudePid: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('end'),
    turnId: z.string(),
    sessionId: z.string(),
    ref: z.string(),
    at: z.string(),
  }),
]);

export type TurnEvent = z.infer<typeof TurnEventSchema>;

export interface Turn {
  id: string;
  sessionId: string;
  prompt: string;
  startedAt: string;
  startRef: string;
  claudePid?: number;
  /** Snapshot taken when Claude stopped; absent while the turn is running or if it was interrupted. */
  endRef?: string;
  endedAt?: string;
}

export async function appendTurnEvent(file: string, event: TurnEvent): Promise<void> {
  await appendFile(file, `${JSON.stringify(event)}\n`);
}

/** Reads the log, skipping malformed lines (e.g. a partial write after a crash). */
export async function readTurns(file: string): Promise<Turn[]> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const events: TurnEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = TurnEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Ignore unparsable lines.
    }
  }
  return foldTurns(events);
}

/** Folds start/end events into turns, oldest first. */
export function foldTurns(events: readonly TurnEvent[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const event of events) {
    if (event.type === 'start') {
      turns.set(event.turnId, {
        id: event.turnId,
        sessionId: event.sessionId,
        prompt: event.prompt,
        startedAt: event.at,
        startRef: event.ref,
        claudePid: event.claudePid,
      });
    } else {
      const turn = turns.get(event.turnId);
      if (turn && !turn.endRef) Object.assign(turn, { endRef: event.ref, endedAt: event.at });
    }
  }
  return [...turns.values()];
}

/** The most recent turn of a session that has not ended yet. */
export function openTurn(turns: readonly Turn[], sessionId: string): Turn | undefined {
  const last = turns.filter((turn) => turn.sessionId === sessionId).at(-1);
  return last && !last.endRef ? last : undefined;
}

/**
 * The ref that marks where a turn's changes stop. An interrupted turn (no Stop event) ends where
 * the session's next turn starts; the latest unfinished turn ends at the live working tree.
 */
export function effectiveEndRef(turns: readonly Turn[], turn: Turn): string | undefined {
  if (turn.endRef) return turn.endRef;
  const sessionTurns = turns.filter((t) => t.sessionId === turn.sessionId);
  const next = sessionTurns[sessionTurns.findIndex((t) => t.id === turn.id) + 1];
  return next?.startRef;
}
