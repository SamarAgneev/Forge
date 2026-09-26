import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Conversation } from '../src/core/conversation.js';
import { runRepl } from '../src/cli/repl.js';
import { TerminalTool } from '../src/core/terminal-tool.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-terminal-flow-'));
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

function commandPlanResponse(commands, summary = 'Run the requested check.') {
  return `<forge-command-plan>${JSON.stringify({ summary, commands })}</forge-command-plan>`;
}

async function runSession(root, input, commands, { script, responseOverride } = {}) {
  if (script) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test-script.js' } }));
    await writeFile(join(root, 'test-script.js'), script);
  }
  const terminalTool = new TerminalTool(root, { timeoutMs: 10_000 });
  let providerCalls = 0;
  const commandResults = [];
  const conversation = new Conversation({
    async complete(messages) {
      providerCalls += 1;
      if (providerCalls === 1) return responseOverride ?? commandPlanResponse(commands);
      const resultMessage = messages.find((message) => message.role === 'system' && message.content.includes('One explicitly approved command'));
      assert.ok(resultMessage, 'approved command result should be sent to the model');
      const result = JSON.parse(resultMessage.content.slice(resultMessage.content.lastIndexOf('\n\n') + 2));
      commandResults.push(result);
      return result.timedOut
        ? 'The command timed out.'
        : result.success
          ? 'Tests completed successfully.'
          : `Command failed with exit code ${result.exitCode}.`;
    }
  }, { terminalTool });
  const chunks = [];
  await runRepl({
    input: Readable.from([input], { objectMode: false }),
    output: createOutput(chunks),
    conversation
  });
  return { rendered: chunks.join(''), providerCalls, commandResults };
}

test('running tests requires approval, then reports captured result to user and AI', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Run the tests.\ny\n',
      [{ executable: 'npm', args: ['test'] }],
      { script: "console.log('PASS sample.test.js');" }
    );

    assert.match(result.rendered, /Forge wants to run: Run the requested check\./);
    assert.match(result.rendered, /1\. npm test \[development\]/);
    assert.match(result.rendered, /Allow command 1 of 1\? \[y\/N\]/);
    assert.match(result.rendered, /Running npm test/);
    assert.match(result.rendered, /Tests completed successfully\./);
    assert.match(result.rendered, /PASS sample\.test\.js/);
    assert.equal(result.providerCalls, 2);
    assert.equal(result.commandResults[0].exitCode, 0);
    assert.match(result.commandResults[0].stdout, /PASS sample\.test\.js/);
  });
});

test('rejecting a test command does not execute it', async () => {
  await withWorkspace(async (root) => {
    const markerPath = join(root, 'did-run.txt');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');`;
    const result = await runSession(
      root,
      'Run the tests.\nn\n',
      [{ executable: 'npm', args: ['test'] }],
      { script }
    );

    assert.match(result.rendered, /Command plan rejected\. No commands were run/);
    assert.equal(result.providerCalls, 1);
    await assert.rejects(readFile(markerPath));
  });
});

test('reports a failing approved command with captured stdout, stderr, and exit status', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Run the tests.\ny\n',
      [{ executable: 'npm', args: ['test'] }],
      { script: "console.log('failure details'); console.error('diagnostic stderr'); process.exitCode = 5;" }
    );

    assert.match(result.rendered, /Command failed with exit code 5/);
    assert.match(result.rendered, /Exit code: 5/);
    assert.match(result.rendered, /failure details/);
    assert.match(result.rendered, /diagnostic stderr/);
    assert.equal(result.commandResults[0].success, false);
    assert.equal(result.commandResults[0].exitCode, 5);
  });
});

test('each command in a sequence needs a new approval', async () => {
  await withWorkspace(async (root) => {
    const result = await runSession(
      root,
      'Run npm test and then check node version.\ny\ny\n',
      [
        { executable: 'npm', args: ['test'] },
        { executable: 'node', args: ['--version'] }
      ],
      { script: "console.log('first command ran');" }
    );

    assert.match(result.rendered, /1\. npm test/);
    assert.match(result.rendered, /2\. node --version/);
    assert.match(result.rendered, /Allow this command\? \[y\/N\]/);
    assert.match(result.rendered, /Running node --version/);
    assert.equal(result.commandResults.length, 2);
    assert.equal(result.commandResults[1].command, 'node --version');
  });
});

test('destructive and shell-injected model-proposed commands are blocked without an approval prompt', async () => {
  await withWorkspace(async (root) => {
    const destructive = await runSession(
      root,
      'Run the tests.\n',
      [{ executable: 'git', args: ['reset', '--hard'] }]
    );

    const injected = await runSession(
      root,
      'Run the tests.\n',
      [{ executable: 'npm', args: ['test', '&&', 'git', 'reset', '--hard'] }]
    );

    for (const result of [destructive, injected]) {
      assert.match(result.rendered, /Command plan blocked by Forge policy/);
      assert.doesNotMatch(result.rendered, /Allow command 1/);
      assert.equal(result.providerCalls, 1);
    }
    assert.match(destructive.rendered, /Git reset is blocked/);
    assert.match(injected.rendered, /Shell operators/);
  });
});