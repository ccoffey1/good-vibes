import type { ReviewThread } from './model';

/** Reads a repo-relative file's lines, or undefined if it no longer exists. */
export type LineReader = (file: string) => Promise<string[] | undefined>;

const EXCERPT_CONTEXT = 2;
const EXCERPT_MAX_LINES = 40;

/**
 * The markdown handed to Claude when the user sends comments. Each thread carries its location,
 * the code it is anchored to, and the whole conversation, so Claude doesn't need extra lookups.
 */
export async function renderOutbox(threads: readonly ReviewThread[], readLines: LineReader): Promise<string> {
  const count = threads.length;
  const parts = [
    '# Code review feedback',
    '',
    `I reviewed your changes and left ${count} comment thread${count === 1 ? '' : 's'}. Handle each one: answer questions, and make requested changes (or explain why not).`,
    'Reply on each thread with `ReplyToDiffComment` (its thread id is below) saying what you did or answering the question; a short summary in chat is fine too. Do not close threads; I will. If that tool is not available, reply in chat instead and do not mention the tool.',
    '',
  ];
  for (const [index, thread] of threads.entries()) {
    parts.push(await renderThread(thread, index + 1, readLines), '');
  }
  return parts.join('\n');
}

async function renderThread(thread: ReviewThread, number: number, readLines: LineReader): Promise<string> {
  const lines = [`## ${number}. ${thread.file}:${formatRange(thread)}`, '', `Thread id: \`${thread.id}\`${thread.outdated ? ' (outdated: the code it was left on has changed)' : ''}`, ''];
  const excerpt = await codeExcerpt(thread, readLines);
  if (excerpt) lines.push(excerpt, '');
  for (const comment of thread.comments) {
    const who = comment.author.kind === 'user' ? '**Me**' : `**${comment.author.name}**`;
    lines.push(`${who}: ${indentContinuation(comment.body)}`, '');
  }
  return lines.join('\n').trimEnd();
}

async function codeExcerpt(thread: ReviewThread, readLines: LineReader): Promise<string | undefined> {
  const fileLines = await readLines(thread.file);
  if (!fileLines) return undefined;
  const from = Math.max(1, thread.startLine - EXCERPT_CONTEXT);
  const to = Math.min(fileLines.length, thread.endLine + EXCERPT_CONTEXT, from + EXCERPT_MAX_LINES - 1);
  if (from > to) return undefined;
  const width = String(to).length;
  const body = fileLines
    .slice(from - 1, to)
    .map((text, i) => {
      const line = from + i;
      const marker = line >= thread.startLine && line <= thread.endLine ? '>' : ' ';
      return `${marker} ${String(line).padStart(width)} | ${text}`;
    })
    .join('\n');
  const fence = body.includes('```') ? '````' : '```';
  return `${fence}\n${body}\n${fence}`;
}

/** Plain-text listing for the MCP `GetDiffComments` tool. */
export function renderThreadsForAgent(threads: readonly ReviewThread[]): string {
  return threads
    .map((thread) => {
      const header = [
        `Thread ${thread.id}`,
        `File: ${thread.file}`,
        `Lines: ${formatRange(thread)}`,
        `Status: ${thread.status}${thread.outdated ? ' (outdated)' : ''}`,
      ];
      const comments = thread.comments.map((c) => `[${c.author.kind === 'user' ? 'user' : c.author.name}] ${c.body}`);
      return [...header, ...comments].join('\n');
    })
    .join('\n\n---\n\n');
}

export function formatRange(thread: Pick<ReviewThread, 'startLine' | 'endLine'>): string {
  return thread.startLine === thread.endLine ? String(thread.startLine) : `${thread.startLine}-${thread.endLine}`;
}

function indentContinuation(body: string): string {
  return body.trim().replace(/\n/g, '\n  ');
}
