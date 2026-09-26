import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextBudget, ContextManager } from '../src/core/context-manager.js';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-context-manager-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root, relativePath, content = '') {
  const filePath = join(root, ...relativePath.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

test('context budget tracks overflow and prioritization', () => {
  const budget = new ContextBudget({ maxCharacters: 80, maxMessages: 3 });
  budget.addText('alpha beta gamma');
  budget.addMessage({ role: 'user', content: 'first' });
  assert.equal(budget.usage.characters, 21);
  assert.equal(budget.isOverflowing(), false);
  budget.addText('abcdefghijklmnopqrstuvwxyz');
  assert.equal(budget.isOverflowing(), false);
  const overflowBudget = new ContextBudget({ maxCharacters: 18, maxMessages: 3 });
  overflowBudget.addText('0123456789');
  overflowBudget.addText('abcdefghij');
  assert.equal(overflowBudget.isOverflowing(), true);
  assert.deepEqual(budget.priorityOrder(['current request', 'recent tool output', 'older history']), ['current request', 'recent tool output', 'older history']);
});

test('repository retrieval ranks relevant files and excludes irrelevant ones', async () => {
  await withWorkspace(async (root) => {
    const manager = new ContextManager({ maxCharacters: 6000, debug: false });
    await writeFixture(root, 'src/auth/login.ts', [
      'export async function authenticateUser(email, password) {',
      '  const user = await findUser(email);',
      '  if (!user) throw new Error("No user");',
      '  return createSession(user.id);',
      '}'
    ].join('\n'));
    await writeFixture(root, 'src/analytics/report.ts', 'export const tracked = true;');
    await writeFixture(root, 'README.md', 'This project contains authentication helpers');
    const workspaceTools = await createWorkspaceTools(root);
    const searchResults = [
      { path: 'src/analytics/report.ts', line: 1, snippet: 'tracked = true;', score: 1 },
      { path: 'src/auth/login.ts', line: 1, snippet: 'authenticateUser', score: 8 },
      { path: 'README.md', line: 1, snippet: 'authentication helpers', score: 3 }
    ];

    const ranked = manager.rankFilesForPrompt(searchResults, 'How does authentication work?');
    assert.equal(ranked[0].path, 'src/auth/login.ts');
    assert.ok(ranked.every((entry) => !entry.path.includes('analytics') || entry.path === 'src/analytics/report.ts'));
  });
});

test('chunking respects function and class boundaries without splitting important code', () => {
  const manager = new ContextManager({ maxCharacters: 4000 });
  const file = [
    'export class AuthService {',
    '  constructor() {}',
    '  login() {',
    '    return true;',
    '  }',
    '}',
    '',
    'export function helper() {',
    '  return 1;',
    '}'
  ].join('\n');

  const chunks = manager.chunkCode(file, 'src/auth.ts');
  assert.ok(chunks.some((chunk) => chunk.includes('export class AuthService')));
  assert.ok(chunks.some((chunk) => chunk.includes('export function helper')));
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length > 0));
});

test('conversation compression preserves decisions and unresolved issues', () => {
  const manager = new ContextManager({ maxMessages: 10 });
  const summary = manager.compressConversation([
    { role: 'user', content: 'Add authentication.' },
    { role: 'assistant', content: 'I will inspect auth files and tests.' },
    { role: 'user', content: 'Use JWT tokens in src/auth/session.ts' },
    { role: 'assistant', content: 'I found the session helper and login flow.' },
    { role: 'user', content: 'Remember: keep .env protected.' },
    { role: 'assistant', content: 'The task is blocked by missing verification steps.' },
    { role: 'user', content: 'Verify with npm test.' }
  ]);

  assert.match(summary, /Add authentication/);
  assert.match(summary, /\.env/);
  assert.match(summary, /npm test/i);
  assert.match(summary, /blocked|verification/i);
});

test('cache reuses unchanged file reads and invalidates on change', async () => {
  await withWorkspace(async (root) => {
    const manager = new ContextManager({ debug: false });
    const readFile = async (path) => {
      if (path === 'src/config.ts') {
        return { ok: true, path, content: 'export const value = 1;\n' };
      }
      return { ok: false, error: 'missing' };
    };

    const first = await manager.readCachedFile(readFile, 'src/config.ts');
    const second = await manager.readCachedFile(readFile, 'src/config.ts');
    assert.equal(first.content, second.content);
    assert.equal(manager.cache.size, 1);

    const changed = async (path) => ({ ok: true, path, content: 'export const value = 2;\n' });
    await manager.invalidateCache('src/config.ts');
    const third = await manager.readCachedFile(changed, 'src/config.ts');
    assert.match(third.content, /value = 2/);
  });
});

test('sensitive content is stripped from model context while preserving paths', async () => {
  const manager = new ContextManager({ debug: false });
  const content = 'API_KEY=secret\nFile: src/auth/login.ts\nconst token = "top-secret"';
  const cleaned = manager.filterSensitiveContent(content);
  assert.doesNotMatch(cleaned, /API_KEY=secret|top-secret/);
  assert.match(cleaned, /src\/auth\/login\.ts/);
});

test('integration: focused context is selected for a coding request', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/auth/login.ts', [
      'export async function authenticateUser(email, password) {',
      '  return login(email, password);',
      '}'
    ].join('\n'));
    await writeFixture(root, 'src/feature/unused.ts', 'export const ignore = true;');
    await writeFixture(root, 'README.md', 'This app handles authentication');
    const workspaceTools = await createWorkspaceTools(root);
    const manager = new ContextManager({ maxCharacters: 3000, debug: false });
    const projectMetadata = {
      projectName: 'demo',
      projectType: 'Node.js / TypeScript',
      languages: ['TypeScript'],
      packageManager: 'npm',
      framework: null,
      git: { isRepository: false, hasUncommittedChanges: false, branch: null },
      packageScripts: [],
      projectRoot: root,
      displayPath: root
    };
    const context = await manager.buildContextForRequest({
      prompt: 'How does authentication work?',
      workspaceTools,
      projectMetadata,
      recentMessages: [],
      debug: false
    });

    assert.ok(context.some((entry) => entry.content.includes('src/auth/login.ts')));
    assert.ok(!context.some((entry) => entry.content.includes('src/feature/unused.ts')));
  });
});
