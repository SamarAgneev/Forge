import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';

async function withWorkspace(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-tools-'));
  try {
    await run(root, await createWorkspaceTools(root, options));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root, path, content = '') {
  const filePath = join(root, ...path.split('/'));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

test('reads text files and supports bounded line ranges', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, 'src/example.js', 'first line\nsecond line\nthird line\n');
    await writeFixture(root, 'src/config.js', "const apiKey = 'test-inline-secret-value';\n");

    const complete = await tools.readFile('src/example.js');
    const range = await tools.readFile('src/example.js', { startLine: 2, endLine: 2 });
    const redacted = await tools.readFile('src/config.js');

    assert.equal(complete.ok, true);
    assert.equal(complete.path, 'src/example.js');
    assert.match(complete.content, /first line/);
    assert.equal(range.content, 'second line');
    assert.equal(range.startLine, 2);
    assert.equal(range.endLine, 2);
    assert.doesNotMatch(redacted.content, /test-inline-secret-value/);
    assert.match(redacted.content, /\[REDACTED\]/);
  });
});

test('reports missing paths and directories without throwing', async () => {
  await withWorkspace(async (root, tools) => {
    await mkdir(join(root, 'src'));

    assert.match((await tools.readFile('missing.js')).error, /not found/);
    assert.match((await tools.readFile('src')).error, /directory/);
  });
});

test('refuses binary and oversized files with useful metadata', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, 'image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    await writeFixture(root, 'document.txt', '%PDF-1.5\nprintable binary signature');
    await writeFixture(root, 'large.txt', '0123456789abcdef');

    const binary = await tools.readFile('image.png');
    const signatureBinary = await tools.readFile('document.txt');
    const oversized = await tools.readFile('large.txt', { maxFileBytes: 8 });

    assert.equal(binary.binary, true);
    assert.match(binary.error, /Binary files/);
    assert.equal(signatureBinary.binary, true);
    assert.equal(oversized.tooLarge, true);
    assert.equal(oversized.sizeBytes, 16);
    assert.match(oversized.error, /too large/);
  });
});

test('rejects traversal and absolute paths outside the workspace', async () => {
  await withWorkspace(async (root, tools) => {
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'forge-outside-'));
    const outsidePath = join(outsideDirectory, 'outside-forge-secret.txt');
    await writeFile(outsidePath, 'must not be read');
    try {
      const traversal = await tools.readFile('../outside-forge-secret.txt');
      const absolute = await tools.readFile(outsidePath);

      assert.match(traversal.error, /traversal/);
      assert.match(absolute.error, /relative to the workspace/);
      assert.doesNotMatch(JSON.stringify([traversal, absolute]), /must not be read/);
    } finally {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});

test('does not follow symlinks outside the workspace', async (context) => {
  await withWorkspace(async (root, tools) => {
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'forge-link-target-'));
    try {
      const outsidePath = join(outsideDirectory, 'private.txt');
      await writeFile(outsidePath, 'external-link-content');
      let linkedPath = 'linked.txt';
      try {
        await symlink(outsidePath, join(root, 'linked.txt'), 'file');
      } catch {
        linkedPath = 'linked-dir/private.txt';
        try {
          await symlink(outsideDirectory, join(root, 'linked-dir'), 'junction');
        } catch {
          context.skip('This platform does not permit creating test symlinks or junctions');
          return;
        }
      }

      const result = await tools.readFile(linkedPath);
      assert.equal(result.ok, false);
      assert.match(result.error, /Symbolic links/);
      assert.doesNotMatch(JSON.stringify(result), /external-link-content/);
    } finally {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});

test('protects environment, key, ignored, and Git-internal files', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, '.env', 'PASSWORD=do-not-return');
    await writeFixture(root, 'keys/private.pem', 'private-material');
    await writeFixture(root, '.git/config', 'git-internal-data');
    await writeFixture(root, '.gitignore', 'ignored/\n');
    await writeFixture(root, 'ignored/module.js', 'ignored-code');
    await writeFixture(root, 'src/.gitignore', 'private/\n');
    await writeFixture(root, 'src/private/account.js', 'nested-ignored-code');

    for (const file of ['.env', 'keys/private.pem', '.git/config', 'ignored/module.js', 'src/private/account.js']) {
      const result = await tools.readFile(file);
      assert.equal(result.ok, false, file);
      assert.doesNotMatch(JSON.stringify(result), /do-not-return|private-material|git-internal-data|ignored-code|nested-ignored-code/);
    }
  });
});

test('lists root and relative directories with filters and bounded depth', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, 'src/auth/login.ts', '');
    await writeFixture(root, 'src/readme.md', '');
    await writeFixture(root, 'tests/login.test.ts', '');
    await writeFixture(root, 'node_modules/pkg/index.js', '');

    const rootListing = await tools.listDirectory('.', { recursive: true, maxDepth: 1 });
    const filtered = await tools.listDirectory('src/auth', { extensions: '.ts' });

    assert.equal(rootListing.ok, true);
    assert.ok(rootListing.entries.some((entry) => entry.path === 'src/auth'));
    assert.ok(!rootListing.entries.some((entry) => entry.path.startsWith('node_modules/')));
    assert.ok(!rootListing.entries.some((entry) => entry.path === 'src/auth/login.ts'));
    assert.deepEqual(filtered.entries.map((entry) => entry.path), ['src/auth/login.ts']);
  });
});

test('searches exact text with case controls, filters, and line-numbered snippets', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, 'src/auth/login.ts', [
      'export async function authenticateUser(email: string) {',
      '  const session = await createSession(email);',
      '  return session;',
      '}'
    ].join('\n'));
    await writeFixture(root, 'tests/login.test.js', 'createSession is covered here');
    await writeFixture(root, 'docs/notes.md', 'CREATESESSION is mentioned here');

    const exact = await tools.searchCode('createSession', {
      caseSensitive: true,
      extensions: '.ts',
      filePattern: '*login*',
      directory: 'src'
    });
    const insensitive = await tools.searchCode('AUTHENTICATEUSER', { caseSensitive: false });
    const missing = await tools.searchCode('definitelyNotPresent');

    assert.equal(exact.results.length, 1);
    assert.equal(exact.results[0].path, 'src/auth/login.ts');
    assert.equal(exact.results[0].line, 2);
    assert.match(exact.results[0].snippet, /createSession/);
    assert.equal(insensitive.results[0].line, 1);
    assert.deepEqual(missing.results, []);
  });
});

test('search excludes ignored directories and reports bounded results', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, '.gitignore', 'private-area/\n');
    await writeFixture(root, 'src/app.js', 'needle();\nneedle();\nneedle();\nneedle();\nneedle();');
    await writeFixture(root, 'private-area/leak.js', 'needle();');

    const results = await tools.searchCode('needle', { maxResults: 2 });

    assert.equal(results.results.length, 2);
    assert.ok(results.results.every((result) => result.path === 'src/app.js'));
    assert.equal(results.truncated, true);
  });
});

test('search uses its deeper configured scan limit', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFixture(root, 'a/b/c/d/target.js', 'deepMatch();');

    const results = await tools.searchCode('deepMatch');

    assert.equal(results.results[0].path, 'a/b/c/d/target.js');
  });
});