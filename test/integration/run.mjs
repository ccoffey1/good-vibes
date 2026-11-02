// Usage: node test/integration/run.mjs <scratch-dir>
// Builds a fixture repo, launches the installed VS Code with an isolated profile, runs suite.js.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = path.dirname(fileURLToPath(import.meta.url));
// Set when this runs from VS Code's own terminal/extension host; it would make Code start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;
const scratch = path.resolve(process.argv[2] ?? path.join(here, '.run'));
const repo = path.join(scratch, 'fixture');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q', '-b', 'main');
writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
git('add', '-A');
git('commit', '-qm', 'initial');
git('checkout', '-qb', 'feature');
writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
writeFileSync(path.join(repo, 'b.txt'), 'BEE\n');
writeFileSync(path.join(repo, 'c.txt'), 'new file\n');

const results = path.join(scratch, 'results.json');
const fakeClaudeDir = path.join(scratch, 'bin');
mkdirSync(fakeClaudeDir);
symlinkSync('/bin/cat', path.join(fakeClaudeDir, 'claude'));
// VS Code's IPC socket lives in the user-data dir and macOS caps socket paths at 103 chars.
const profile = mkdtempSync(path.join(os.tmpdir(), 'gv-'));
await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: path.resolve(here, '../..'),
  extensionTestsPath: path.join(here, 'suite.js'),
  launchArgs: [repo, '--user-data-dir', path.join(profile, 'data'), '--extensions-dir', path.join(profile, 'ext'), '--disable-workspace-trust'],
  extensionTestsEnv: { GOOD_VIBES_RESULTS: results, GOOD_VIBES_FAKE_CLAUDE_DIR: fakeClaudeDir },
});
rmSync(profile, { recursive: true, force: true });

const actual = JSON.parse(readFileSync(results, 'utf8'));
const expected = {
  errors: [],
  scopeLabel: 'Branch vs main',
  files: ['modified:a.txt', 'modified:b.txt', 'added:c.txt'],
  openDiffTab: { label: 'a.txt · Branch vs main', isDiff: true, rightScheme: 'file' },
  leftContent: 'one\ntwo\n',
  markViewedAndNext: { firstViewed: true, active: 'b.txt · Branch vs main' },
  unmarkViewed: { viewedAfterUnmark: false, viewedAfterRemark: true, active: 'b.txt · Branch vs main' },
  layoutToggle: 'c.txt (added) · Branch vs main',
  threadsAfterExternalWrite: 2,
  nextComment: 'a.txt:2',
  terminalDelivery: { queued: true, outboxTabOpen: false, commentsOpenView: 'never' },
  resolve: 'resolved',
};
const failures = Object.entries(expected).filter(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value));
const send = actual.send ?? {};
if (!/^@\.good-vibes\/outbox\/review-.*\.md$/.test(send.mention ?? '') || send.queued !== 1 || !send.outboxHasComment || !send.outboxHasExcerpt) failures.push(['send', send]);
for (const [key] of failures) console.error(`FAIL ${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
console.log(failures.length === 0 ? 'Integration checks passed.' : `${failures.length} integration check(s) failed.`);
process.exit(failures.length === 0 ? 0 : 1);
