/**
 * MCP server Claude Code launches (stdio). Gives Claude review tools:
 * read the workspace diff, read the user's review comments, and leave/answer comments that
 * show up inline in VS Code.
 *
 * Usage: node mcp.js [--root <repo>] [--base <branch>]
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openRepository } from '../core/repository';
import { diffComment, getDiffComments, getWorkspaceDiff, replyToDiffComment, ToolInputError, type ToolContext } from './tools';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function run(action: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await action() }] };
  } catch (error) {
    const message = error instanceof ToolInputError ? error.message : `Error: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function main(): Promise<void> {
  const root = argValue('--root') ?? process.cwd();
  const repo = await openRepository(root);
  if (!repo) {
    process.stderr.write(`good-vibes MCP: ${root} is not inside a git repository\n`);
    process.exit(1);
  }
  const ctx: ToolContext = { repo, baseBranch: argValue('--base') };
  const server = new McpServer({ name: 'good-vibes', version: '0.1.0' });

  server.registerTool(
    'GetWorkspaceDiff',
    {
      description:
        'Shows what the user is reviewing: all changes on the current branch (committed and uncommitted, including untracked files) against the merge base with the base branch. Use when the user refers to "the diff", "all changes", or "my review". scope "uncommitted" limits it to changes since HEAD. With stat: true, returns per-file statistics. With file, returns that file\'s unified diff.',
      inputSchema: {
        file: z.string().optional().describe('Repo-relative or absolute path of a single file to diff'),
        stat: z.boolean().optional().describe('Return git diff --stat style per-file statistics'),
        scope: z.enum(['branch', 'uncommitted']).optional().describe('Defaults to branch'),
      },
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => getWorkspaceDiff(ctx, input)),
  );

  server.registerTool(
    'GetDiffComments',
    {
      description:
        'Reads the review comments the user (and agents) left on the diff in VS Code, e.g. when asked to "address the comments" or "read my review". Returns open threads with ids, file, line range, and the conversation. Reading does not resolve them.',
      inputSchema: {
        file: z.string().optional().describe('Repo-relative path to only return comments on that file'),
        includeResolved: z.boolean().optional().describe('Also return resolved threads'),
      },
      annotations: { readOnlyHint: false },
    },
    (input) => run(() => getDiffComments(ctx, input)),
  );

  server.registerTool(
    'DiffComment',
    {
      description:
        "Leaves review feedback inline on the user's diff in VS Code. Each comment targets a file and line (optionally a range). Use this instead of posting review comments to GitHub unless the user explicitly asks for GitHub. Write plain prose; put any code longer than a few words in a fenced code block with a language tag (e.g. ```ts), which VS Code syntax-highlights.",
      inputSchema: {
        comments: z
          .array(
            z.object({
              file: z.string().describe('Repo-relative or absolute file path'),
              lineNumber: z.number().int().describe('1-based line in the current working-tree file'),
              endLineNumber: z.number().int().optional().describe('Last line of a multi-line range'),
              body: z.string().describe('The comment'),
            }),
          )
          .min(1),
      },
    },
    (input) => run(() => diffComment(ctx, input)),
  );

  server.registerTool(
    'ReplyToDiffComment',
    {
      description:
        'Replies to a review comment thread (ids come from GetDiffComments or the feedback file). Use it to answer a question or say what you changed. You cannot close threads; the user does. Write plain prose; put any code longer than a few words in a fenced code block with a language tag (e.g. ```ts), which VS Code syntax-highlights.',
      inputSchema: {
        threadId: z.string(),
        body: z.string().describe('What you changed, or why you did not. Code goes in fenced blocks with a language tag.'),
      },
    },
    (input) => run(() => replyToDiffComment(ctx, input)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`good-vibes MCP failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
