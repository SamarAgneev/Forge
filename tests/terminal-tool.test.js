import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandPolicy, TerminalTool } from '../src/core/terminal-tool.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-terminal-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeNpmScript(root, source) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test-script.js' } }));
  await writeFile(join(root, 'test-script.js'), source);
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  killSignals = [];

  kill(signal) {
    this.killSignals.push(signal);
    this.emit('close', null, signal);
    return true;
  }
}

test('command policy allows known read/development commands only with approval', () => {
  const policy = new CommandPolicy();

  assert.equal(policy.classify({ executable: 'git', args: ['status', '--short'] }).category, 'read-only');
  assert.equal(policy.classify({ executable: 'npm', args: ['test'] }).category, 'development');
  assert.equal(policy.classify({ executable: 'cargo', args: ['test'] }).disposition, 'requires-approval');
  assert.equal(policy.classify({ executable: 'npm', args: ['install'] }).ok, false);
  assert.equal(policy.classify({ executable: 'git', args: ['reset', '--hard'] }).category, 'potentially-destructive');
});

test('blocks shell execution, chaining, redirects, substitutions, traversal, and outside paths', () => {
  const policy = new CommandPolicy();
  const rejected = [
    { executable: 'sh', args: ['-c', 'npm test; rm -rf .'] },
    { executable: 'npm', args: ['test', '&&', 'git', 'reset'] },
    { executable: 'npm', args: ['test', '>', 'result.txt'] },
    { executable: 'npm', args: ['test', '$(whoami)'] },
    { executable: 'npm', args: ['test', '../other-project'] },
    { executable: 'npm', args: ['test', 'C:\\outside'] }
  ];

  for (const command of rejected) assert.equal(policy.classify(command).ok, false);
});

test('requires approval and executes a successful command in the workspace', async () => {
  await withWorkspace(async (root) => {
    const tool = new TerminalTool(root);
    const pending = await tool.runCommand({ executable: 'pwd', args: [] });
    const result = await tool.runCommand({ executable: 'pwd', args: [] }, { approved: true });

    assert.equal(pending.requiresApproval, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.workingDirectory, '.');
    assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(result.timedOut, false);
  });
});

test('captures real stdout, stderr, exit code, and duration from a failing test command', async () => {
  await withWorkspace(async (root) => {
    await writeNpmScript(root, "console.log('test stdout'); console.error('test stderr'); console.log('cwd=' + process.cwd()); process.exitCode = 7;");
    const tool = new TerminalTool(root, { timeoutMs: 20_000 });
    const result = await tool.runCommand({ executable: 'npm', args: ['test'] }, { approved: true });

    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /test stdout/);
    assert.match(result.stdout, new RegExp(`cwd=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stderr, /test stderr/);
    assert.ok(result.durationMs >= 0);
    assert.equal(result.timedOut, false);
  });
});

test('times out a running process and sends a termination signal', async () => {
  await withWorkspace(async (root) => {
    const child = new FakeChild();
    const tool = new TerminalTool(root, {
      timeoutMs: 100,
      spawnImplementation: () => child
    });
    const result = await tool.runCommand({ executable: 'npm', args: ['--version'] }, { approved: true, timeoutMs: 100 });

    assert.equal(result.timedOut, true);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(result.exitCode, null);
  });
});

test('caps large output and marks truncation', async () => {
  await withWorkspace(async (root) => {
    const longOutput = 'x'.repeat(10_000);
    await writeNpmScript(root, `process.stdout.write(${JSON.stringify(longOutput)});`);
    const tool = new TerminalTool(root, {
      timeoutMs: 20_000,
      limits: { maxStdoutBytes: 512, maxStderrBytes: 512, maxTotalOutputBytes: 512 }
    });
    const result = await tool.runCommand({ executable: 'npm', args: ['test'] }, { approved: true });

    assert.equal(result.outputTruncated, true);
    assert.match(`${result.stdout}${result.stderr}`, /\[output truncated\]/);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 1200);
  });
});

test('redacts credential-shaped output and does not pass arbitrary environment secrets', async () => {
  await withWorkspace(async (root) => {
    const previous = process.env.FORGE_TERMINAL_TEST_SECRET;
    process.env.FORGE_TERMINAL_TEST_SECRET = 'do-not-inherit-this-value';
    const child = new FakeChild();
    let spawnOptions;
    const tool = new TerminalTool(root, {
      spawnImplementation: (executable, args, options) => {
        spawnOptions = options;
        setImmediate(() => {
          child.stdout.write('API_KEY=printed-secret-value\nOPENAI_API_KEY=namespaced-secret-value\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      }
    });
    try {
      const result = await tool.runCommand({ executable: 'npm', args: ['--version'] }, { approved: true });

      assert.doesNotMatch(result.stdout, /printed-secret-value/);
      assert.doesNotMatch(result.stdout, /namespaced-secret-value/);
      assert.equal(spawnOptions.env.FORGE_TERMINAL_TEST_SECRET, undefined);
      assert.equal(spawnOptions.env.OPENAI_API_KEY, undefined);
      assert.equal(spawnOptions.shell, false);
    } finally {
      if (previous === undefined) delete process.env.FORGE_TERMINAL_TEST_SECRET;
      else process.env.FORGE_TERMINAL_TEST_SECRET = previous;
    }
  });
});

test('refuses a working directory outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-terminal-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'forge-terminal-outside-'));
  try {
    const tool = new TerminalTool(root, { currentWorkingDirectory: outside });
    const result = await tool.runCommand({ executable: 'pwd', args: [] }, { approved: true });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('does not resolve an allowlisted executable from the workspace PATH', async () => {
  await withWorkspace(async (root) => {
    const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
    await writeFile(join(root, executableName), 'workspace shadow executable');
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const previousPath = process.env[pathKey];
    process.env[pathKey] = [root, previousPath].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
    try {
      const tool = new TerminalTool(root);
      const resolved = await tool.resolveExecutable('node');
      assert.ok(resolved === null || resolved.toLowerCase().startsWith(root.toLowerCase()) === false);
    } finally {
      if (previousPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previousPath;
    }
  });
});

test('each command in a multi-command plan requires a separate approval', async () => {
  await withWorkspace(async (root) => {
    const tool = new TerminalTool(root);
    const prepared = await tool.preparePlan({
      summary: 'Check environment then repository status',
      commands: [
        { executable: 'node', args: ['--version'] },
        { executable: 'pwd', args: [] }
      ]
    });

    assert.equal(prepared.ok, true);
    assert.match(prepared.plan.preview, /1\. node --version/);
    assert.match(prepared.plan.preview, /2\. pwd/);
    assert.match(prepared.plan.preview, /Allow command 1 of 2/);
    const first = await tool.approveNext(prepared.plan.id, { approved: true });
    assert.equal(first.complete, false);
    assert.equal(first.nextCommand, 'pwd');
    const rejected = await tool.approveNext(prepared.plan.id);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /approval/);
    const second = await tool.approveNext(prepared.plan.id, { approved: true });
    assert.equal(second.complete, true);
  });
});

test('terminates an actually hanging approved npm test command', async () => {
  await withWorkspace(async (root) => {
    await writeNpmScript(root, 'setInterval(() => {}, 1000);');
    const tool = new TerminalTool(root, { timeoutMs: 250, limits: { killGraceMs: 100 } });

    const result = await tool.runCommand({ executable: 'npm', args: ['test'] }, { approved: true });

    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 5000);
    assert.equal(result.exitCode === null || result.exitCode !== 0, true);
  });
});