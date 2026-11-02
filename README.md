# Good Vibes Review

A VS Code extension for reviewing Claude Code's changes like a pull request, then sending your feedback straight back to Claude.

## Features

- **Review scopes.** The whole branch vs. its base, uncommitted changes, a single commit, or one Claude turn (just what Claude changed for one prompt).
- **File list.** List or folder-tree view, with +/− counts and a **Viewed** checkbox. A file is unchecked again if it changes. Diffs open in VS Code's own diff editor, and you can edit the right side.
- **Inline comments.** Click the gutter `+` on a line or selection. **Add to Chat** sends the comment, along with the code it points at, to a Claude session you choose: one in a VS Code terminal or a chat in the Claude Code extension. You then press Enter in Claude.
- **Claude replies inline.** Claude can leave its own review comments and reply on your threads through an MCP server bundled with the extension. Only you can close threads.

## Install

```sh
npm install
npm run package      # typecheck, test, build, and create good-vibes-<version>.vsix
code --install-extension good-vibes-*.vsix
```

Then, in each repository, run **Good Vibes: Connect Claude Code** from the command palette. It adds two Claude Code hooks to `.claude/settings.local.json`; they take a snapshot of the code at the start and end of each turn. It also registers the `good-vibes` MCP server for the project. Restart Claude sessions afterwards.

## How it works

- **Turn snapshots.** Each snapshot saves your whole working tree to a private git ref (`refs/good-vibes/checkpoints/*`). HEAD, the index and your files are never touched.
- **Comments** are stored in `.good-vibes/comments.json`. The extension adds `.good-vibes/` to `.git/info/exclude`, so it never shows up in git.
- **Sending** writes the threads to a Markdown file under `.good-vibes/outbox/` and puts an `@` mention of that file into Claude's input.

## Development

```sh
npm run build              # bundle with esbuild
npm test                   # unit tests (vitest), using temporary git repos
npm run test:integration   # runs the extension inside your installed VS Code with an isolated profile
```

Press F5 in VS Code to launch an Extension Development Host.
