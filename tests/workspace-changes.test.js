import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceChangeManager } from '../src/core/workspace-changes.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-changes-'));
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

test('file creation produces a diff and requires explicit approval', async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, 'src'));
    const manager = new WorkspaceChangeManager(root);
    const prepared = await manager.createFile('src/hello.ts', 'export const hello = "world";\n');

    assert.equal(prepared.ok, true);
    assert.match(prepared.proposal.preview, /Create src\/hello\.ts/);
    assert.match(prepared.proposal.diff, /\+export const hello/);
    await assert.rejects(readFile(join(root, 'src', 'hello.ts')));

    const rejected = await manager.applyChangeSet(prepared.proposal.id);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Explicit approval/);
    await assert.rejects(readFile(join(root, 'src', 'hello.ts')));

    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(root, 'src', 'hello.ts'), 'utf8'), 'export const hello = "world";\n');
  });
});

test('creation rejects existing files and only creates parent directories when requested', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'existing.txt', 'keep me');
    const manager = new WorkspaceChangeManager(root);

    const conflict = await manager.createFile('existing.txt', 'overwrite');
    const missingParent = await manager.createFile('src/api/hello.ts', 'export {};');
    const nested = await manager.createFile('src/api/hello.ts', 'export {};', { createDirectories: true });

    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /already exists/);
    assert.equal(missingParent.ok, false);
    assert.match(missingParent.error, /Parent directories/);
    assert.match(nested.proposal.preview, /also create src, src\/api/);
    const applied = await manager.applyChangeSet(nested.proposal.id, { approved: true });
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(root, 'src', 'api', 'hello.ts'), 'utf8'), 'export {};');
  });
});

test('exact edits preserve unrelated content and reject ambiguous or missing context', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'README.md', 'Opening\nInstall with npm.\nClosing\n');
    const manager = new WorkspaceChangeManager(root);
    const prepared = await manager.editFile('README.md', 'Install with npm.', 'Install with npm.cmd.');

    assert.equal(prepared.ok, true);
    assert.match(prepared.proposal.diff, /-Install with npm\./);
    assert.match(prepared.proposal.diff, /\+Install with npm\.cmd\./);
    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Opening\nInstall with npm.cmd.\nClosing\n');

    await writeFixture(root, 'repeated.js', 'same();\nsame();\n');
    const ambiguous = await manager.editFile('repeated.js', 'same();', 'different();');
    const absent = await manager.editFile('repeated.js', 'missing();', 'different();');
    assert.match(ambiguous.error, /occurs 2 times/);
    assert.match(absent.error, /not found/);
  });
});

test('full-file writes require an expected hash, overwrite intent, preview, and approval', async () => {
  await withWorkspace(async (root) => {
    const initial = 'export const value = 1;\n';
    await writeFixture(root, 'src/config.js', initial);
    const manager = new WorkspaceChangeManager(root);
    const refused = await manager.writeFile('src/config.js', 'export const value = 2;\n');
    const staleHash = await manager.writeFile('src/config.js', 'export const value = 2;\n', {
      overwrite: true,
      expectedHash: 'not-the-current-hash'
    });
    const prepared = await manager.writeFile('src/config.js', 'export const value = 2;\n', {
      overwrite: true,
      expectedHash: createHash('sha256').update(initial).digest('hex')
    });

    assert.match(refused.error, /overwrite:true and an expectedHash/);
    assert.match(staleHash.error, /changed since it was inspected/);
    assert.equal(prepared.ok, true);
    assert.equal(await readFile(join(root, 'src', 'config.js'), 'utf8'), initial);
    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(root, 'src', 'config.js'), 'utf8'), 'export const value = 2;\n');
  });
});

test('stale edits are rejected without overwriting concurrent changes', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/value.js', 'export const value = 1;\n');
    const manager = new WorkspaceChangeManager(root);
    const prepared = await manager.editFile('src/value.js', 'value = 1', 'value = 2');
    await writeFixture(root, 'src/value.js', 'export const value = 3;\n');

    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });

    assert.equal(applied.ok, false);
    assert.match(applied.error, /changed after the proposal/);
    assert.equal(await readFile(join(root, 'src', 'value.js'), 'utf8'), 'export const value = 3;\n');

    const newFile = await manager.createFile('new-file.js', 'export const current = false;');
    await writeFixture(root, 'new-file.js', 'created by another process');
    const createResult = await manager.applyChangeSet(newFile.proposal.id, { approved: true });
    assert.equal(createResult.ok, false);
    assert.match(createResult.error, /Target appeared/);
    assert.equal(await readFile(join(root, 'new-file.js'), 'utf8'), 'created by another process');
  });
});

test('protected file creation requires a second exact confirmation and existing secrets cannot be edited', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, '.gitignore', '.env\n');
    const manager = new WorkspaceChangeManager(root);
    const protectedProposal = await manager.createFile('.env', 'API_KEY=generated-value\n');

    assert.equal(protectedProposal.ok, true);
    assert.match(protectedProposal.proposal.preview, /WARNING:.*protected\/sensitive file/);
    const firstApproval = await manager.applyChangeSet(protectedProposal.proposal.id, { approved: true });
    assert.equal(firstApproval.requiresProtectedConfirmation, true);
    await assert.rejects(readFile(join(root, '.env')));

    const secondApproval = await manager.applyChangeSet(protectedProposal.proposal.id, {
      approved: true,
      protectedConfirmation: true
    });
    assert.equal(secondApproval.ok, true);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'API_KEY=generated-value\n');

    const existingProtectedEdit = await manager.editFile('.env', 'API_KEY=generated-value', 'API_KEY=replacement');
    assert.equal(existingProtectedEdit.ok, false);
    assert.match(existingProtectedEdit.error, /sensitive files cannot be read or edited/);
  });
});

test('multi-file operations preflight and rollback as a unit', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/app.js', 'export const status = "old";\n');
    const manager = new WorkspaceChangeManager(root);
    const prepared = await manager.prepareChangeSet({
      summary: 'Add a helper and use it',
      changes: [
        { action: 'create', path: 'src/helpers.js', content: 'export const helper = true;\n' },
        { action: 'edit', path: 'src/app.js', oldText: 'status = "old"', newText: 'status = "new"' }
      ]
    });

    assert.equal(prepared.ok, true);
    assert.equal(prepared.proposal.changes.length, 2);
    assert.match(prepared.proposal.diff, /src\/helpers\.js/);
    assert.match(prepared.proposal.diff, /src\/app\.js/);
    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });
    assert.equal(applied.ok, true);
    assert.equal(await readFile(join(root, 'src', 'helpers.js'), 'utf8'), 'export const helper = true;\n');
    assert.match(await readFile(join(root, 'src', 'app.js'), 'utf8'), /status = "new"/);

    const rollback = await manager.rollback(applied.operationId);
    assert.equal(rollback.ok, true);
    await assert.rejects(readFile(join(root, 'src', 'helpers.js')));
    assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'export const status = "old";\n');
  });
});

test('failure during a multi-file apply restores prior files and created directories', async () => {
  await withWorkspace(async (root) => {
    class FailingManager extends WorkspaceChangeManager {
      installCount = 0;

      async installStage(stagePath, targetPath) {
        this.installCount += 1;
        if (this.installCount === 2) throw new Error('Injected stage installation failure');
        return super.installStage(stagePath, targetPath);
      }
    }
    const manager = new FailingManager(root);
    const prepared = await manager.prepareChangeSet({
      summary: 'Create a small set',
      changes: [
        { action: 'create', path: 'new/nested/one.js', content: 'one();', createDirectories: true },
        { action: 'create', path: 'new/nested/two.js', content: 'two();', createDirectories: true }
      ]
    });

    const applied = await manager.applyChangeSet(prepared.proposal.id, { approved: true });

    assert.equal(applied.ok, false);
    assert.equal(applied.rollbackComplete, true);
    await assert.rejects(readFile(join(root, 'new', 'nested', 'one.js')));
    await assert.rejects(readFile(join(root, 'new')));
  });
});

test('write boundaries reject traversal, absolute paths, and protected edits', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/safe.js', 'const x = 1;');
    await writeFixture(root, '.env', 'API_KEY=do-not-read');
    const manager = new WorkspaceChangeManager(root);

    const traversal = await manager.createFile('../outside.js', 'bad');
    const absolute = await manager.createFile(join(root, 'absolute.js'), 'bad');
    const binary = await manager.createFile('image.png', 'not binary bytes');
    const secretEdit = await manager.editFile('.env', 'API_KEY=do-not-read', 'API_KEY=changed');

    assert.equal(traversal.ok, false);
    assert.equal(absolute.ok, false);
    assert.match(binary.error, /Binary file creation/);
    assert.equal(secretEdit.ok, false);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'API_KEY=do-not-read');
    await assert.rejects(readFile(join(dirname(root), 'outside.js')));
  });
});