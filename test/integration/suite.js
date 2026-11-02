// Runs inside VS Code's extension host (loaded by @vscode/test-electron). Plain JS on purpose:
// it is not bundled and only talks to the extension through the VS Code API and its test API.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async function run() {
  const results = { errors: [] };
  const step = async (name, fn) => {
    try {
      results[name] = await fn();
    } catch (error) {
      results.errors.push(`${name}: ${error && error.stack ? error.stack : error}`);
    }
  };
  const ext = vscode.extensions.getExtension('good-vibes.good-vibes');
  const api = await ext.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;

  await step('scopeLabel', async () => {
    await api.model.refresh();
    return api.model.snapshot.resolved.label;
  });
  await step('files', () => api.model.snapshot.files.map((f) => `${f.status}:${f.path}`));
  await step('commandsRegistered', async () => (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('goodVibes.')).length);
  await step('openDiffTab', async () => {
    await vscode.commands.executeCommand('goodVibes.openFile', api.model.snapshot.files[0].path);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return { label: tab.label, isDiff: tab.input instanceof vscode.TabInputTextDiff, rightScheme: tab.input.modified && tab.input.modified.scheme };
  });
  await step('leftContent', async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return (await vscode.workspace.openTextDocument(tab.input.original)).getText();
  });
  await step('markViewedAndNext', async () => {
    const first = api.model.snapshot.files[0];
    await vscode.commands.executeCommand('goodVibes.markViewedAndNext');
    return { firstViewed: api.model.isViewed(first), active: vscode.window.tabGroups.activeTabGroup.activeTab.label };
  });
  await step('unmarkViewed', async () => {
    await vscode.commands.executeCommand('goodVibes.openFile', 'a.txt');
    await vscode.commands.executeCommand('goodVibes.unmarkViewed');
    const a = api.model.snapshot.files.find((f) => f.path === 'a.txt');
    const viewedAfterUnmark = api.model.isViewed(a);
    await vscode.commands.executeCommand('goodVibes.markViewedAndNext');
    return { viewedAfterUnmark, viewedAfterRemark: api.model.isViewed(a), active: vscode.window.tabGroups.activeTabGroup.activeTab.label };
  });
  await step('layoutToggle', async () => {
    await vscode.commands.executeCommand('goodVibes.viewAsTree');
    await vscode.commands.executeCommand('goodVibes.nextFile');
    const inTree = vscode.window.tabGroups.activeTabGroup.activeTab.label;
    await vscode.commands.executeCommand('goodVibes.viewAsList');
    return inTree;
  });
  await step('threadsAfterExternalWrite', async () => {
    // Simulates Claude's MCP server writing a comment while VS Code is open.
    const now = new Date().toISOString();
    const comment = (id, kind, body) => ({ id, author: { kind, name: kind === 'user' ? 'You' : 'Claude' }, body, createdAt: now });
    const data = {
      version: 1,
      threads: [
        { id: 't-user', file: 'a.txt', startLine: 2, endLine: 2, anchor: 'TWO', status: 'open', outdated: false, comments: [comment('c1', 'user', 'lowercase please')], createdAt: now, updatedAt: now },
        { id: 't-agent', file: 'a.txt', startLine: 3, endLine: 3, anchor: 'three', status: 'open', outdated: false, comments: [comment('c2', 'agent', 'new line added')], createdAt: now, updatedAt: now },
      ],
    };
    fs.writeFileSync(path.join(root, '.good-vibes', 'comments.json'), JSON.stringify(data));
    for (let i = 0; i < 50 && api.model.threads.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    return api.model.threads.length;
  });
  await step('nextComment', async () => {
    await vscode.commands.executeCommand('goodVibes.nextComment');
    const editor = vscode.window.activeTextEditor;
    return editor && `${path.basename(editor.document.uri.fsPath)}:${editor.selection.active.line + 1}`;
  });
  await step('send', async () => {
    await vscode.workspace.getConfiguration('goodVibes').update('delivery', 'clipboard', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('goodVibes.sendToClaude');
    const mention = (await vscode.env.clipboard.readText()).trim();
    const outbox = fs.readFileSync(path.join(root, mention.slice(1)), 'utf8');
    return { mention, queued: api.model.threads.filter((t) => t.comments.some((c) => c.author.kind === 'user' && c.queuedIn && !c.sentAt)).length, outboxHasComment: outbox.includes('lowercase please'), outboxHasExcerpt: outbox.includes('> 2 | TWO') };
  });
  await step('terminalDelivery', async () => {
    // A stand-in `claude` process (a symlink to cat, so it stays alive reading the terminal).
    const fake = path.join(process.env.GOOD_VIBES_FAKE_CLAUDE_DIR, 'claude');
    const terminal = vscode.window.createTerminal({ name: 'fake claude', shellPath: '/bin/sh', shellArgs: ['-c', `${fake}; true`] });
    await new Promise((r) => setTimeout(r, 1500));
    const data = JSON.parse(fs.readFileSync(path.join(root, '.good-vibes', 'comments.json'), 'utf8'));
    const now = new Date().toISOString();
    data.threads.push({ id: 't-term', file: 'b.txt', startLine: 1, endLine: 1, anchor: 'BEE', status: 'open', outdated: false, comments: [{ id: 'c3', author: { kind: 'user', name: 'You' }, body: 'to the terminal', createdAt: now }], createdAt: now, updatedAt: now });
    fs.writeFileSync(path.join(root, '.good-vibes', 'comments.json'), JSON.stringify(data));
    await api.model.reloadComments();
    await vscode.workspace.getConfiguration('goodVibes').update('delivery', 'terminal', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('goodVibes.sendToClaude');
    const queued = Boolean(api.model.threads.find((t) => t.id === 't-term').comments[0].queuedIn);
    const outboxTabOpen = vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input && t.input.uri && t.input.uri.fsPath.includes('/outbox/'));
    terminal.dispose();
    return { queued, outboxTabOpen, commentsOpenView: vscode.workspace.getConfiguration('comments').get('openView') };
  });
  await step('resolve', async () => {
    await vscode.commands.executeCommand('goodVibes.closeThread', 't-agent');
    return api.model.threads.find((t) => t.id === 't-agent').status;
  });

  fs.writeFileSync(process.env.GOOD_VIBES_RESULTS, JSON.stringify(results, null, 2));
};
