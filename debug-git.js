import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitService } from './src/core/git-service.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'forge-git-debug-'));
const git = (...args) => execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });

try {
  await git('init', '--quiet');
  await git('config', 'user.name', 'Forge Test');
  await git('config', 'user.email', 'forge@example.com');
  await writeFile(join(root, 'README.md'), 'hello\n');
  await git('add', 'README.md');
  await git('commit', '-m', 'base', '--no-gpg-sign');
  await writeFile(join(root, 'README.md'), 'hello\nupdated\n');
  await writeFile(join(root, 'notes.txt'), 'draft\n');

  const service = new GitService(root);
  const preview = await service.previewCommit({ files: ['README.md', 'notes.txt'], message: 'fix: update project notes' });
  console.log('PREVIEW', JSON.stringify(preview, null, 2));

  const committed = await service.commit({ message: 'fix: update project notes', files: ['README.md', 'notes.txt'], approved: true });
  console.log('COMMIT', JSON.stringify(committed, null, 2));
} catch (error) {
  console.log('ERROR', error);
} finally {
  await rm(root, { recursive: true, force: true });
}
