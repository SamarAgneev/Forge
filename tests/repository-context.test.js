import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Conversation } from '../src/core/conversation.js';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-repository-context-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root, path, content = '') {
  const filePath = join(root, ...path.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

test('repository questions add focused, cited source context to the model request', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/auth/login.ts', [
      'export async function authenticateUser(email, password) {',
      '  const user = await findUser(email);',
      '  if (!user || !verifyPassword(password, user.passwordHash)) {',
      "    throw new Error('Invalid credentials');",
      '  }',
      '  return createSession(user.id);',
      '}'
    ].join('\n'));
    await writeFixture(root, 'src/unused.js', 'export function unrelated() {}');
    await writeFixture(root, '.env', 'API_KEY=must-not-enter-context');
    const workspaceTools = await createWorkspaceTools(root);
    let request;
    const conversation = new Conversation({
      async complete(messages) {
        request = messages;
        const evidence = messages.find((message) => message.role === 'system' && message.content.includes('Focused repository evidence'));
        assert.ok(evidence);
        assert.match(evidence.content, /File: src\/auth\/login\.ts/);
        assert.match(evidence.content, /1: export async function authenticateUser/);
        assert.match(evidence.content, /6:   return createSession/);
        assert.doesNotMatch(evidence.content, /must-not-enter-context|src\/unused\.js/);
        return 'Authentication is implemented by authenticateUser, which verifies the password and creates a session (src/auth/login.ts:1,6).';
      }
    }, { workspaceTools });

    const answer = await conversation.ask('How does authentication work in this project?');

    assert.match(answer, /src\/auth\/login\.ts:1,6/);
    assert.ok(request.some((message) => message.content.includes('Focused repository evidence')));
    assert.deepEqual(conversation.getMessages(), [
      { role: 'user', content: 'How does authentication work in this project?' },
      { role: 'assistant', content: answer }
    ]);
  });
});

test('unmatched repository questions tell the model not to invent code details', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/plain.js', 'export const answer = 42;');
    const workspaceTools = await createWorkspaceTools(root);
    let request;
    const conversation = new Conversation({
      async complete(messages) {
        request = messages;
        return 'I could not find relevant repository evidence.';
      }
    }, { workspaceTools });

    await conversation.ask('Where is the authentication flow implemented?');

    const context = request.find((message) => message.role === 'system');
    assert.match(context.content, /No relevant repository code was found/);
    assert.match(context.content, /instead of guessing/);
  });
});

test('workspace path traversal questions retrieve the actual guard with citations', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/workspace-policy.js', [
      'export function resolveWorkspacePath(path) {',
      "  const segments = path.split('/');",
      "  if (segments.includes('..')) return { error: 'Path traversal is not allowed.' };",
      '  return resolveInsideWorkspace(segments);',
      '}'
    ].join('\n'));
    await writeFixture(root, 'README.md', 'Path traversal is prevented before files are read.');
    const workspaceTools = await createWorkspaceTools(root);
    let request;
    const conversation = new Conversation({
      async complete(messages) {
        request = messages;
        return 'The path guard rejects `..` segments (src/workspace-policy.js:3).';
      }
    }, { workspaceTools });

    const answer = await conversation.ask('Where does Forge prevent path traversal?');
    const repositoryContext = request.find((message) => message.content.includes('Focused repository evidence'));

    assert.ok(repositoryContext);
    assert.match(repositoryContext.content, /File: src\/workspace-policy\.js/);
    assert.match(repositoryContext.content, /3:   if \(segments\.includes/);
    assert.match(answer, /src\/workspace-policy\.js:3/);
  });
});

test('explicit sensitive and binary file questions do not disclose contents', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, '.env', 'API_KEY=must-never-be-read');
    await writeFixture(root, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    const workspaceTools = await createWorkspaceTools(root);
    const originalReadFile = workspaceTools.readFile.bind(workspaceTools);
    const readPaths = [];
    workspaceTools.readFile = async (path, options) => {
      readPaths.push(path);
      return originalReadFile(path, options);
    };
    let request;
    const conversation = new Conversation({
      async complete(messages) {
        request = messages;
        return 'I cannot inspect that file.';
      }
    }, { workspaceTools });

    await conversation.ask('What is inside .env?');
    const environmentContext = request.find((message) => message.role === 'system');
    assert.match(environmentContext.content, /protected by workspace policy/);
    assert.equal(readPaths.length, 0);

    await conversation.ask('What is inside assets/logo.png?');
    const binaryContext = request.find((message) => message.role === 'system');
    assert.match(binaryContext.content, /binary and cannot be inspected/);
    assert.deepEqual(readPaths, ['assets/logo.png']);
    assert.doesNotMatch(JSON.stringify(request), /must-never-be-read/);
  });
});

test('ordinary chat does not trigger repository search', async () => {
  let searchCalls = 0;
  const conversation = new Conversation({ complete: async () => 'Hello.' }, {
    workspaceTools: { searchCode: async () => { searchCalls += 1; return { ok: true, results: [] }; } }
  });

  assert.equal(await conversation.ask('Hello there.'), 'Hello.');
  assert.equal(searchCalls, 0);
});