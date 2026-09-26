import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { GitService } from '../src/core/git-service.js';

const execFileAsync = promisify(execFile);

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-git-'));
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

async function git(root, args) {
  return execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

async function initRepo(root) {
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.name', 'Forge Test']);
  await git(root, ['config', 'user.email', 'forge@example.com']);
}

test('detects a repository and reports branch status without exposing internals', async () => {
  await withWorkspace(async (root) => {
    await initRepo(root);
    await writeFixture(root, 'README.md', 'hello\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'initial commit', '--no-gpg-sign']);
    await writeFixture(root, 'README.md', 'hello\nupdated\n');
    await writeFixture(root, 'notes.txt', 'draft\n');

    const service = new GitService(root);
    const status = await service.status();

    assert.equal(status.isRepository, true);
    assert.equal(status.branch, 'master');
    assert.ok(status.modifiedFiles.includes('README.md'));
    assert.ok(status.untrackedFiles.includes('notes.txt'));
    assert.deepEqual(status.conflictedFiles, []);
    assert.ok(!JSON.stringify(status).includes('.git'));
  });
});

test('reports a non-Git workspace clearly and without initializing Git', async () => {
  await withWorkspace(async (root) => {
    const service = new GitService(root);
    const status = await service.status();

    assert.equal(status.isRepository, false);
    assert.match(status.message, /not a Git repository/i);
    assert.equal(status.branch, null);
  });
});

test('captures diffs, log entries, and protects destructive or remote commands', async () => {
  await withWorkspace(async (root) => {
    await initRepo(root);
    await writeFixture(root, 'README.md', 'one\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'first commit', '--no-gpg-sign']);

    await writeFixture(root, 'README.md', 'one\nsecond\n');
    await writeFixture(root, 'tracked.txt', 'draft\n');

    const service = new GitService(root);
    const diff = await service.diff({ file: 'README.md' });
    const log = await service.log({ limit: 5 });

    assert.equal(diff.ok, true);
    assert.match(diff.text, /README.md/);
    assert.ok(log.ok);
    assert.ok(log.commits.length >= 1);
    assert.match(log.commits[0].message, /first commit/);

    const blockedRemote = await service.run(['push']);
    assert.equal(blockedRemote.ok, false);
    assert.match(blockedRemote.error, /remote|blocked/i);

    const blockedDestructive = await service.run(['reset', '--hard']);
    assert.equal(blockedDestructive.ok, false);
    assert.match(blockedDestructive.error, /destructive|blocked/i);
  });
});

test('stages only approved files and blocks sensitive files by default', async () => {
  await withWorkspace(async (root) => {
    await initRepo(root);
    await writeFixture(root, 'README.md', 'hello\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'base', '--no-gpg-sign']);

    await writeFixture(root, 'README.md', 'hello\nupdated\n');
    await writeFixture(root, 'notes.txt', 'draft\n');
    await writeFixture(root, '.env', 'TOKEN=secret\n');

    const service = new GitService(root);

    const rejectSensitive = await service.stageFiles(['.env']);
    assert.equal(rejectSensitive.ok, false);
    assert.match(rejectSensitive.error, /sensitive|secret|blocked/i);

    const approveStage = await service.stageFiles(['README.md', 'notes.txt'], { approved: true });
    assert.equal(approveStage.ok, true);
    assert.deepEqual(approveStage.stagedFiles.sort(), ['README.md', 'notes.txt']);

    const status = await service.status();
    assert.ok(status.stagedFiles.includes('README.md'));
    assert.ok(status.stagedFiles.includes('notes.txt'));
  });
});

test('preview shows the exact files and requires explicit approval before commit', async () => {
  await withWorkspace(async (root) => {
    await initRepo(root);
    await writeFixture(root, 'README.md', 'hello\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'base', '--no-gpg-sign']);

    await writeFixture(root, 'README.md', 'hello\nupdated\n');
    await writeFixture(root, 'notes.txt', 'draft\n');

    const service = new GitService(root);
    const preview = await service.previewCommit({
      files: ['README.md', 'notes.txt'],
      message: 'fix: update project notes'
    });

    assert.equal(preview.ok, true);
    assert.deepEqual(preview.files.sort(), ['README.md', 'notes.txt']);
    assert.match(preview.proposal.message, /fix: update project notes/i);

    const blocked = await service.commit({ message: 'fix: update project notes', files: ['README.md', 'notes.txt'], approved: false });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /approval|approve/i);

    const committed = await service.commit({ message: 'fix: update project notes', files: ['README.md', 'notes.txt'], approved: true });
    assert.equal(committed.ok, true);
    assert.ok(committed.commitHash);
  });
});
