import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { saveCheckpoint } from '../core/checkpoints';
import type { GitRunner } from '../core/git';
import { findClaudeAncestor, readProcessTable } from '../core/processes';
import { openRepository } from '../core/repository';
import { markOutboxesSent, outboxMentions } from '../core/comments/ops';
import { appendTurnEvent, openTurn, readTurns } from '../core/turns';

/** The subset of Claude Code's hook payload we use. */
export const HookInputSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  cwd: z.string(),
  prompt: z.string().optional(),
});

export type HookInput = z.infer<typeof HookInputSchema>;

export type HookResult =
  | { kind: 'recorded'; turnId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string; logFile?: string };

export interface HookDeps {
  runner?: GitRunner;
  now?: () => Date;
  /** PID of the Claude CLI that invoked the hook, if it can be found. */
  findClaudePid?: () => Promise<number | undefined>;
}

async function claudePidFromProcessTree(): Promise<number | undefined> {
  return findClaudeAncestor(await readProcessTable(), process.pid)?.pid;
}

export async function handleHookEvent(input: HookInput, deps: HookDeps = {}): Promise<HookResult> {
  const now = deps.now ?? (() => new Date());
  const repo = await openRepository(input.cwd, deps.runner);
  if (!repo) return { kind: 'skipped', reason: 'not a git repository' };

  try {
    switch (input.hook_event_name) {
      case 'UserPromptSubmit': {
        const turnId = `${now().getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
        const [checkpoint, claudePid] = await Promise.all([
          saveCheckpoint(repo.git, `${turnId}-start`),
          (deps.findClaudePid ?? claudePidFromProcessTree)().catch(() => undefined),
        ]);
        await appendTurnEvent(repo.layout.turnsFile, {
          type: 'start',
          turnId,
          sessionId: input.session_id,
          prompt: input.prompt ?? '',
          ref: checkpoint.ref,
          at: now().toISOString(),
          claudePid,
        });
        // Review comments count as sent only once a prompt mentioning their outbox file is submitted.
        const mentioned = outboxMentions(input.prompt ?? '');
        if (mentioned.length > 0) await repo.comments.update((data) => markOutboxesSent(data, mentioned));
        return { kind: 'recorded', turnId };
      }
      case 'Stop': {
        const turn = openTurn(await readTurns(repo.layout.turnsFile), input.session_id);
        if (!turn) return { kind: 'skipped', reason: 'no open turn for session' };
        const checkpoint = await saveCheckpoint(repo.git, `${turn.id}-end`);
        await appendTurnEvent(repo.layout.turnsFile, {
          type: 'end',
          turnId: turn.id,
          sessionId: input.session_id,
          ref: checkpoint.ref,
          at: now().toISOString(),
        });
        return { kind: 'recorded', turnId: turn.id };
      }
      default:
        return { kind: 'skipped', reason: `unhandled event ${input.hook_event_name}` };
    }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error), logFile: repo.layout.hookLog };
  }
}
