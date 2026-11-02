/**
 * Claude Code hook: snapshots the working tree when a prompt is submitted and when Claude stops,
 * so every turn's changes can be reviewed on their own.
 *
 * Must stay silent on stdout (UserPromptSubmit stdout is added to Claude's context) and must never
 * fail the hook: errors are appended to `.good-vibes/hook.log` and the process exits 0.
 */
import { appendFile } from 'node:fs/promises';
import { handleHookEvent, HookInputSchema } from './turnRecorder';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const parsed = HookInputSchema.safeParse(JSON.parse(await readStdin()));
  if (!parsed.success) return;
  const result = await handleHookEvent(parsed.data);
  if (result.kind === 'error' && result.logFile) {
    await appendFile(result.logFile, `${new Date().toISOString()} ${parsed.data.hook_event_name}: ${result.message}\n`).catch(() => undefined);
  }
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
