import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Conversation } from '../src/core/conversation.js';
import { runRepl } from '../src/cli/repl.js';
import { WorkspaceChangeManager } from '../src/core/workspace-changes.js';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-change-flow-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createOutput(chunks) {
  return new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
}

function createProposalResponse(changes, summary = 'Add the requested utility.') {
  return `<forge-change-set>${JSON.stringify({ summary, changes })}</forge-change-set>`;
}

async function runSession(root, inputText, changes, { summary, ignoredEnv = false, responseOverride } = {}) {
  if (ignoredEnv) await writeFile(join(root, '.gitignore'), '.env\n');
  const workspaceTools = await createWorkspaceTools(root);
  const changeManager = new WorkspaceChangeManager(root);
  let providerCalls = 0;
  let sawInstructions = false;
  let sawExplicitFileContext = false;
  const conversation = new Conversation({
    async complete(messages) {
      providerCalls += 1;
      sawInstructions = messages.some((message) => message.role === 'system' && message.content.includes('You may only PROPOSE changes'));
      sawExplicitFileContext = messages.some((message) => message.role === 'system' && message.content.includes('The user explicitly referenced this workspace file'));
      return responseOverride ?? createProposalResponse(changes, summary);
    }
  }, { workspaceTools, changeManager });
  const chunks = [];

  await runRepl({
    input: Readable.from([inputText], { objectMode: false }),
    output: createOutput(chunks),
    conversation
  });
  return { rendered: chunks.join(''), providerCalls, sawInstructions, sawExplicitFileContext };
}

test('natural create request shows a full diff and applies only after y approval', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Create utils/math.ts with add and subtract functions.\ny\n',
      [{
        action: 'create',
        path: 'utils/math.ts',
        content: 'export const add = (a: number, b: number) => a + b;\nexport const subtract = (a: number, b: number) => a - b;\n',
        createDirectories: true
      }]
    );

    assert.equal(result.providerCalls, 1);
    assert.equal(result.sawInstructions, true);
    assert.match(result.rendered, /Files:\n- Create utils\/math\.ts/);
    assert.match(result.rendered, /\+export const add/);
    assert.match(result.rendered, /Apply this complete change set\? \[y\/N\/a\]/);
    assert.match(result.rendered, /Changes applied successfully/);
    assert.equal(await readFile(join(root, 'utils', 'math.ts'), 'utf8'),
      'export const add = (a: number, b: number) => a + b;\nexport const subtract = (a: number, b: number) => a - b;\n');
  });
});

test('natural-language agreement outside a pending state does not approve, and n rejects', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Create hello.js.\nyes please\nn\n',
      [{ action: 'create', path: 'hello.js', content: 'console.log("hello");\n' }]
    );

    assert.equal(result.providerCalls, 1);
    assert.match(result.rendered, /Enter y to apply this complete change set/);
    assert.match(result.rendered, /Changes rejected/);
    await assert.rejects(readFile(join(root, 'hello.js')));
  });
});

test('exiting with a pending proposal cancels it without writing', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Create cancel-me.js.\nexit\n',
      [{ action: 'create', path: 'cancel-me.js', content: 'export {};\n' }]
    );

    assert.match(result.rendered, /Pending changes cancelled/);
    await assert.rejects(readFile(join(root, 'cancel-me.js')));
  });
});

test('a applies the entire multi-file proposal and malformed model output writes nothing', async () => {
  await withWorkspace(async (root) => {
    const applied = await runSession(
      root,
      'Create first.js and second.js.\na\n',
      [
        { action: 'create', path: 'first.js', content: 'export const first = true;\n' },
        { action: 'create', path: 'second.js', content: 'export const second = true;\n' }
      ],
      { summary: 'Create both files.' }
    );
    assert.match(applied.rendered, /Apply this complete change set\? \[y\/N\/a\]/);
    assert.equal(await readFile(join(root, 'first.js'), 'utf8'), 'export const first = true;\n');
    assert.equal(await readFile(join(root, 'second.js'), 'utf8'), 'export const second = true;\n');

    const malformed = await runSession(
      root,
      'Create third.js.\n',
      [],
      { responseOverride: 'I will create third.js now.' }
    );
    assert.match(malformed.rendered, /did not contain a validated change proposal/);
    await assert.rejects(readFile(join(root, 'third.js')));
  });
});

test('natural edit request reads the named file, previews an exact patch, and applies it after approval', async () => {
  await withWorkspace(async (root) => {
    const original = '# Setup\nInstall with npm.\nKeep this paragraph.\n';
    await writeFile(join(root, 'README.md'), original);
    const result = await runSession(
      root,
      'Fix the install typo in README.md.\ny\n',
      [{ action: 'edit', path: 'README.md', oldText: 'Install with npm.', newText: 'Install with npm.cmd.' }]
    );

    assert.equal(result.sawExplicitFileContext, true);
    assert.match(result.rendered, /-Install with npm\./);
    assert.match(result.rendered, /\+Install with npm\.cmd\./);
    assert.match(result.rendered, /Changes applied successfully/);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# Setup\nInstall with npm.cmd.\nKeep this paragraph.\n');
    assert.notEqual(await readFile(join(root, 'README.md'), 'utf8'), original);
  });
});

test('protected create requires approval followed by exact stronger confirmation', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Create .env with an API key placeholder.\nCONFIRM PROTECTED\ny\nCONFIRM PROTECTED\n',
      [{ action: 'create', path: '.env', content: 'OPENAI_API_KEY=replace-me\n' }],
      { ignoredEnv: true, summary: 'Create the requested local config file.' }
    );

    assert.match(result.rendered, /WARNING: This creates a protected\/sensitive file/);
    assert.match(result.rendered, /Approve with y first/);
    assert.match(result.rendered, /type CONFIRM PROTECTED/);
    assert.match(result.rendered, /Changes applied successfully/);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'OPENAI_API_KEY=replace-me\n');
  });
});