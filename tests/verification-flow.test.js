import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Conversation } from '../src/core/conversation.js';
import { runRepl } from '../src/cli/repl.js';
import { inspectProject } from '../src/core/project-inspector.js';
import { ProjectVerifier } from '../src/core/project-verification.js';
import { TaskOrchestrator } from '../src/core/task-orchestrator.js';
import { TerminalTool } from '../src/core/terminal-tool.js';
import { WorkspaceChangeManager } from '../src/core/workspace-changes.js';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'forge-verification-flow-'));
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

function createOutput(chunks) {
  return new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
}

async function runVerificationSession(root, input, testScript, { scripts = { test: 'node test-script.js' }, sourceFiles = [] } = {}) {
  await writeFixture(root, 'package.json', JSON.stringify({ scripts }));
  await writeFixture(root, 'test-script.js', testScript);
  for (const [path, content] of sourceFiles) await writeFixture(root, path, content);
  const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
  const workspaceTools = await createWorkspaceTools(root);
  const terminalTool = new TerminalTool(root, { timeoutMs: 10_000 });
  const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
  let providerCalls = 0;
  let modelAnalysis = null;
  const conversation = new Conversation({
    async complete(messages) {
      providerCalls += 1;
      const context = messages.find((message) => message.role === 'system' && message.content.includes('One explicitly approved command'));
      assert.ok(context, 'the model is called only after command approval with structured results');
      modelAnalysis = JSON.parse(context.content.slice(context.content.lastIndexOf('\n\n') + 2));
      return modelAnalysis.success
        ? 'The verification command passed.'
        : `${modelAnalysis.verificationResult.failureClassification}. See ${modelAnalysis.verificationResult.errors[0]?.file ?? 'command output'}.`;
    }
  }, { projectMetadata: project, workspaceTools, terminalTool, projectVerifier });
  const chunks = [];
  await runRepl({ input: Readable.from([input], { objectMode: false }), output: createOutput(chunks), conversation, project });
  return { rendered: chunks.join(''), providerCalls, modelAnalysis };
}

test('successful test verification is detected, approved, run, and reported', async () => {
  await withWorkspace(async (root) => {
    const result = await runVerificationSession(root, 'Run the tests.\ny\n', "console.log('PASS tests/example.test.js');");

    assert.match(result.rendered, /Tests: npm test \[development\]/);
    assert.match(result.rendered, /Allow command 1 of 1\? \[y\/N\]/);
    assert.match(result.rendered, /Status: PASSED/);
    assert.match(result.rendered, /Category: No failure detected/);
    assert.match(result.rendered, /PASS tests\/example\.test\.js/);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.modelAnalysis.exitCode, 0);
  });
});

test('failed verification extracts diagnostics, maps source, and recommends without editing', async () => {
  await withWorkspace(async (root) => {
    const source = 'export function login() {\n  const status: string = 401;\n  return status;\n}\n';
    const result = await runVerificationSession(
      root,
      'Run the tests.\ny\n',
      "console.error('src/auth/login.ts:2:9 - error TS2322: Type number is not assignable to type string.'); process.exitCode = 1;",
      { sourceFiles: [['src/auth/login.ts', source]] }
    );

    assert.match(result.rendered, /Status: FAILED/);
    assert.match(result.rendered, /Category: Likely type error/);
    assert.match(result.rendered, /Affected file: src\/auth\/login\.ts/);
    assert.match(result.rendered, /Line: 2:9/);
    assert.match(result.rendered, /Error code: TS2322/);
    assert.match(result.rendered, /2:   const status/);
    assert.equal(result.modelAnalysis.verificationResult.errors[0].file, 'src/auth/login.ts');
    assert.equal(await readFile(join(root, 'src', 'auth', 'login.ts'), 'utf8'), source);
  });
});

test('a requested category without a configured command reports Not configured and does not call the model', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', JSON.stringify({ scripts: { build: 'node build.js' } }));
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const workspaceTools = await createWorkspaceTools(root);
    const terminalTool = new TerminalTool(root);
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    let providerCalls = 0;
    const conversation = new Conversation({ complete: async () => { providerCalls += 1; return 'unexpected'; } }, { projectVerifier, workspaceTools, terminalTool });

    const answer = await conversation.ask('Run the tests.');

    assert.match(answer, /tests: Not configured/);
    assert.equal(providerCalls, 0);
    assert.equal(conversation.pendingCommandPlan, null);
  });
});

test('an approved change prepares verification but does not run it without command approval', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', JSON.stringify({ scripts: { test: 'node test-script.js' } }));
    await writeFixture(root, 'test-script.js', "require('node:fs').writeFileSync('test-ran', 'yes');\n");
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const workspaceTools = await createWorkspaceTools(root);
    const changeManager = new WorkspaceChangeManager(root);
    const terminalTool = new TerminalTool(root, { timeoutMs: 10_000 });
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    const taskOrchestrator = new TaskOrchestrator({ projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier });
    const conversation = new Conversation({
      complete: async () => `<forge-change-set>${JSON.stringify({
        summary: 'Add a health check endpoint.',
        changes: [{ action: 'create', path: 'health.js', content: 'export function healthCheck() { return { status: "ok" }; }\n' }]
      })}</forge-change-set>`
    }, { projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, taskOrchestrator });

    await conversation.ask('Add a health check endpoint.');
    assert.ok(conversation.pendingChangeProposal);
    const applied = await conversation.approvePendingChange();

    assert.equal(applied.ok, true);
    assert.ok(conversation.pendingCommandPlan);
    assert.equal(conversation.pendingCommandPlan.verification, true);
    assert.match(conversation.pendingCommandPlan.commands[0].command, /npm test/);
    assert.equal(taskOrchestrator.currentTask.state, 'AWAITING_APPROVAL');
    await assert.rejects(readFile(join(root, 'test-ran')));
  });
});

test('a failed post-change check produces an approved bounded repair and verifies it', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'package.json', JSON.stringify({ scripts: { test: 'node test-script.js' } }));
    await writeFixture(root, 'test-script.js', [
      "const fs = require('node:fs');",
      "if (!fs.readFileSync('health.js', 'utf8').includes('status: \"ok\"')) {",
      "  console.error('health.js:1:1 - error TEST_FAIL: expected status ok');",
      '  process.exitCode = 1;',
      '}'
    ].join('\n'));
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const workspaceTools = await createWorkspaceTools(root);
    const changeManager = new WorkspaceChangeManager(root);
    const terminalTool = new TerminalTool(root, { timeoutMs: 10_000 });
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    const taskOrchestrator = new TaskOrchestrator({ projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, maxRepairAttempts: 1 });
    let providerCalls = 0;
    const provider = {
      async complete(messages) {
        providerCalls += 1;
        const commandContext = messages.find((message) => message.role === 'system' && message.content.includes('One explicitly approved command'));
        if (commandContext) {
          const result = JSON.parse(commandContext.content.slice(commandContext.content.lastIndexOf('\n\n') + 2));
          return result.verificationResult?.status === 'PASSED' ? 'The repaired test passes.' : 'The test failed because the health status was wrong.';
        }
        if (messages.some((message) => message.role === 'system' && message.content.includes('Bounded repair attempt'))) {
          return `<forge-change-set>${JSON.stringify({
            summary: 'Return the expected health status.',
            changes: [{ action: 'edit', path: 'health.js', oldText: 'status: "bad"', newText: 'status: "ok"' }]
          })}</forge-change-set>`;
        }
        return `<forge-change-set>${JSON.stringify({
          summary: 'Add the health check endpoint.',
          changes: [{ action: 'create', path: 'health.js', content: 'export function healthCheck() { return { status: "bad" }; }\n' }]
        })}</forge-change-set>`;
      }
    };
    const conversation = new Conversation(provider, { projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, taskOrchestrator });
    const chunks = [];

    await runRepl({
      input: Readable.from(['Add a health check endpoint.\ny\ny\ny\ny\nexit\n'], { objectMode: false }),
      output: createOutput(chunks),
      conversation,
      project
    });

    const rendered = chunks.join('');
    assert.match(rendered, /Repair attempt 1\/1/);
    assert.match(rendered, /Return the expected health status/);
    assert.match(rendered, /Apply this complete change set\? \[y\/N\/a\]/);
    assert.match(rendered, /Changes applied successfully/);
    assert.match(rendered, /Status: PASSED/);
    assert.equal(await readFile(join(root, 'health.js'), 'utf8'), 'export function healthCheck() { return { status: "ok" }; }\n');
    assert.equal(providerCalls, 4);
    assert.equal(taskOrchestrator.currentTask.state, 'COMPLETED');
  });
});

test('rejecting a repair leaves the failed file untouched and cancels the task', async () => {
  await withWorkspace(async (root) => {
    await writeFixture(root, 'health.js', 'export const status = "bad";\n');
    const changeManager = new WorkspaceChangeManager(root);
    const taskOrchestrator = new TaskOrchestrator({ changeManager, maxRepairAttempts: 1 });
    const task = taskOrchestrator.beginTask('Fix the health status.');
    task.context.changeApplied = true;
    const conversation = new Conversation({
      complete: async () => `<forge-change-set>${JSON.stringify({
        summary: 'Return the expected health status.',
        changes: [{ action: 'edit', path: 'health.js', oldText: '"bad"', newText: '"ok"' }]
      })}</forge-change-set>`
    }, { changeManager, taskOrchestrator });

    const proposal = await conversation.prepareRepairProposal(task, { command: 'npm test', exitCode: 1 }, {
      status: 'FAILED',
      command: 'npm test',
      verificationCategory: 'tests',
      failureClassification: 'Likely test failure',
      errors: [{ file: 'health.js', line: 1, message: 'Expected status ok.' }],
      outputExcerpt: 'health.js:1:1 - expected status ok',
      outputTruncated: false
    });
    assert.match(proposal.repairPreview, /Apply this complete change set/);

    const rejected = await conversation.rejectPendingChange();

    assert.equal(rejected.cancelled, true);
    assert.equal(rejected.repair, true);
    assert.match(conversation.messages.at(-1).content, /earlier approved changes remain/);
    assert.equal(task.state, 'CANCELLED');
    assert.equal(await readFile(join(root, 'health.js'), 'utf8'), 'export const status = "bad";\n');
  });
});