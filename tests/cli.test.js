import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function runForge(args, { input = '', apiKey = '', cwd = tmpdir() } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      OPENAI_API_KEY: apiKey,
      DOTENV_CONFIG_PATH: join(cwd, '.forge-test-no-env')
    }
  });
}

test('CLI help works without configuration and explains how to start Forge', () => {
  const result = runForge(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /forge\s+Start an interactive conversation/);
  assert.match(result.stdout, /forge --version/);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  assert.equal(result.stderr, '');
});

test('CLI version matches package.json without requiring configuration', () => {
  const result = runForge(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
  assert.equal(result.stderr, '');
});

test('CLI reports missing configuration before starting the REPL', () => {
  const result = runForge([]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Forge cannot start because the required API key is not configured\./);
  assert.doesNotMatch(result.stderr, /OPENAI_API_KEY=.*|at .*\(/);
});

test('CLI starts and exits cleanly in a temporary project fixture', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'forge-cli-project-'));
  try {
    await writeFile(join(workspace, 'package.json'), '{"name":"fixture"}');
    await writeFile(join(workspace, 'package-lock.json'), '{}');
    await mkdir(join(workspace, 'src'));
    await writeFile(join(workspace, 'src', 'index.js'), 'export const ready = true;');
    const result = runForge([], {
      input: '/project\nexit\n',
      apiKey: 'test-key',
      cwd: workspace
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Model: gpt-4o-mini \(OpenAI\)/);
    assert.match(result.stdout, /Workspace: /);
    assert.match(result.stdout, /Project: forge-cli-project-/);
    assert.match(result.stdout, /Type: Node\.js/);
    assert.match(result.stdout, /Package manager: npm/);
    assert.match(result.stdout, /Goodbye\./);
    assert.doesNotMatch(result.stderr, /test-key/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});