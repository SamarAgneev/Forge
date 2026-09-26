import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { formatProjectSummary, inspectProject } from '../src/core/project-inspector.js';

const execFileAsync = promisify(execFile);

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-inspector-'));
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

test('detects the current empty non-project workspace', async () => {
  await withWorkspace(async (root) => {
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });

    assert.equal(project.workspacePath, root);
    assert.equal(project.projectRoot, root);
    assert.equal(project.isProject, false);
    assert.equal(project.projectType, 'Not detected');
    assert.equal(project.git.isRepository, false);
    assert.deepEqual(project.structure, []);
  });
});

test('detects Node.js, TypeScript, React, and pnpm from bounded metadata', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      dependencies: { react: '^19.0.0' }
    }));
    await writeFixture(root, 'tsconfig.json', '{}');
    await writeFixture(root, 'src/components/App.tsx', 'export default function App() {}');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const summary = formatProjectSummary(project);

    assert.equal(project.isProject, true);
    assert.equal(project.projectType, 'Node.js / TypeScript');
    assert.deepEqual(project.languages, ['JavaScript', 'TypeScript']);
    assert.equal(project.framework, 'React');
    assert.equal(project.packageManager, 'pnpm');
    assert.match(summary, /Project: forge-inspector-/);
    assert.match(summary, /Framework: React/);
    assert.match(summary, /src\//);
  });
});

test('detects a Python project and pip package manager', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'pyproject.toml', '[project]\nname = "fixture"\n');
    await writeFixture(root, 'requirements.txt', 'requests==2.0\n');
    await writeFixture(root, 'main.py', 'print("fixture")\n');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });

    assert.equal(project.projectType, 'Python');
    assert.deepEqual(project.languages, ['Python']);
    assert.equal(project.packageManager, 'pip');
    assert.equal(project.framework, null);
  });
});

test('does not infer a framework from a dependency name alone', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', JSON.stringify({ dependencies: { react: '^19.0.0', next: '^15.0.0' } }));
    await writeFixture(root, 'src/index.js', 'console.log("plain JavaScript");');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });

    assert.equal(project.framework, null);
  });
});

test('detects Git branch and uncommitted changes without altering the fixture', async (context) => {
  await withWorkspace(async (root) => {
    try {
      await execFileAsync('git', ['-C', root, 'init', '--quiet']);
    } catch {
      context.skip('Git is not installed or could not initialize a temporary repository');
      return;
    }
    await writeFixture(root, 'README.md', 'temporary fixture\n');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });

    assert.equal(project.git.isRepository, true);
    assert.ok(project.git.branch);
    assert.equal(project.git.hasUncommittedChanges, true);
    assert.equal(project.structure.some((entry) => entry.path === '.git'), false);
  });
});

test('respects ignore files and excludes generated and sensitive directories', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, '.gitignore', 'ignored/\n*.log\n/root-only.json\n');
    await writeFixture(root, 'ignored/private.txt', 'not scanned');
    await writeFixture(root, 'node_modules/pkg/index.js', 'not scanned');
    await writeFixture(root, 'dist/bundle.js', 'not scanned');
    await writeFixture(root, 'src/app.js', 'safe name only');
    await writeFixture(root, 'src/debug.log', 'ignored by pattern');
    await writeFixture(root, 'root-only.json', 'ignored at root');
    await writeFixture(root, 'src/root-only.json', 'not ignored by anchored pattern');
    await writeFixture(root, 'src/build', 'directory-only pattern does not hide a file');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const paths = project.structure.map((entry) => entry.path);

    assert.ok(paths.includes('src/app.js'));
    assert.ok(!paths.some((path) => path.startsWith('ignored/')));
    assert.ok(!paths.some((path) => path.startsWith('node_modules/')));
    assert.ok(!paths.some((path) => path.startsWith('dist/')));
    assert.ok(!paths.includes('src/debug.log'));
    assert.ok(!paths.includes('root-only.json'));
    assert.ok(paths.includes('src/root-only.json'));
    assert.ok(paths.includes('src/build'));
  });
});

test('applies directory-depth and entry-count limits', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'src/deep/nested/file.js', '');
    await writeFixture(root, 'one.txt', '');
    await writeFixture(root, 'two.txt', '');
    await writeFixture(root, 'three.txt', '');

    const shallow = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0, maxDepth: 1 } });
    assert.ok(shallow.structure.some((entry) => entry.path === 'src/deep'));
    assert.ok(!shallow.structure.some((entry) => entry.path === 'src/deep/nested/file.js'));
    assert.equal(shallow.structureTruncated, true);

    const small = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0, maxEntries: 2 } });
    assert.ok(small.structure.length <= 2);
    assert.equal(small.structureTruncated, true);
  });
});

test('does not expose or include sensitive files in project metadata', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', '{"name":"safe-project"}');
    await writeFixture(root, '.env', 'API_KEY=very-secret-value');
    await writeFixture(root, '.env.local', 'TOKEN=another-secret-value');
    await writeFixture(root, '.envrc', 'THIRD_SECRET=envrc-secret-value');
    await writeFixture(root, 'id_rsa', 'private-key-material');
    await writeFixture(root, 'private_key.json', 'private-json-key-material');
    await writeFixture(root, 'service-account.json', 'service-account-secret-value');
    await writeFixture(root, 'tls/private.pem', 'certificate-material');
    await writeFixture(root, 'credentials.json', 'cloud-credential-material');
    await writeFixture(root, 'secrets.yaml', 'password: hidden-value');

    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const serialized = JSON.stringify(project);

    for (const secret of [
      'very-secret-value', 'another-secret-value', 'envrc-secret-value', 'private-key-material',
      'private-json-key-material', 'service-account-secret-value',
      'certificate-material', 'cloud-credential-material', 'hidden-value'
    ]) {
      assert.ok(!serialized.includes(secret));
    }
    assert.ok(!project.structure.some((entry) => /\.env|id_rsa|private|service-account|credentials|secrets/i.test(entry.path)));
    assert.deepEqual(project.importantFiles, ['package.json']);
  });
});