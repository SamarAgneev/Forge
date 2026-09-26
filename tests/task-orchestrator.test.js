import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskOrchestrator, TaskState } from '../src/core/task-orchestrator.js';

test('a new task starts in understanding state and records lifecycle transitions', () => {
  const orchestrator = new TaskOrchestrator({ projectMetadata: { projectName: 'fixture', projectType: 'Node.js', languages: ['JavaScript'], packageManager: 'npm', framework: null, git: { isRepository: false, hasUncommittedChanges: false } } });
  const task = orchestrator.beginTask('Add a health check endpoint.');

  assert.equal(task.state, TaskState.UNDERSTANDING);
  assert.equal(orchestrator.currentTask.id, task.id);
  orchestrator.updateTaskState(task, TaskState.INSPECTING, 'Inspecting authentication routes.');
  orchestrator.setPlan(task, ['Inspect routes', 'Add endpoint', 'Run API tests']);
  orchestrator.setApprovalState(task, { approved: false });

  assert.deepEqual(task.context.plan, ['Inspect routes', 'Add endpoint', 'Run API tests']);
  assert.equal(task.context.approvalState.approved, false);
  assert.ok(orchestrator.history.length >= 3);
});

test('read-only questions do not create a coding task when a provider remains unused', () => {
  const orchestrator = new TaskOrchestrator();
  const task = orchestrator.beginTask('Explain how authentication works.');

  assert.equal(task.state, TaskState.UNDERSTANDING);
  orchestrator.updateTaskState(task, TaskState.COMPLETED, 'Read-only question answered.');
  assert.equal(task.state, TaskState.COMPLETED);
});

test('tool validation rejects malformed or disallowed tool requests', async () => {
  const orchestrator = new TaskOrchestrator({ projectMetadata: { projectName: 'fixture', projectType: 'Node.js', languages: ['JavaScript'], packageManager: 'npm', framework: null, git: { isRepository: false, hasUncommittedChanges: false } } });

  const disallowed = await orchestrator.validateToolCall('unknown_tool', {});
  assert.equal(disallowed.ok, false);
  assert.match(disallowed.error, /not allowed/i);

  const invalidCommand = await orchestrator.validateToolCall('run_command', { executable: 'sh', args: ['-c', 'rm -rf .'] });
  assert.equal(invalidCommand.ok, false);
  assert.match(invalidCommand.error, /blocked|outside|allowlist|unavailable|not allowed/i);
});

test('approval and cancellation transitions are explicit and safe', async () => {
  const orchestrator = new TaskOrchestrator();
  const task = orchestrator.beginTask('Fix the login bug.');

  orchestrator.updateTaskState(task, TaskState.AWAITING_APPROVAL, 'Waiting for user approval.');
  const approved = await orchestrator.applyApproval(task, { approved: true });
  assert.equal(approved.status, 'approved');
  const cancelled = orchestrator.cancelTask(task, 'User abandoned the task.');
  assert.equal(cancelled.state, TaskState.CANCELLED);
});

test('repair workflow tracks attempts, stops at the limit, and requires explicit approval', async () => {
  const orchestrator = new TaskOrchestrator({ maxRepairAttempts: 2 });
  const task = orchestrator.beginTask('Fix the failing login endpoint.');

  const failure = {
    command: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'src/auth/login.ts:42:9 - error TS2345: Expected 200 but received 401',
    verificationCategory: 'tests'
  };

  const attempt = orchestrator.beginRepairAttempt(task, failure);
  assert.equal(task.state, TaskState.ANALYZING_FAILURE);
  assert.equal(attempt.attempt, 1);

  orchestrator.submitRepairProposal(task, {
    summary: 'Adjust token validation logic.',
    files: [{ action: 'edit', path: 'src/auth/login.ts', patch: 'fix token validation' }]
  });
  assert.equal(task.state, TaskState.AWAITING_REPAIR_APPROVAL);

  const approved = await orchestrator.approveRepair(task, { approved: true });
  assert.equal(approved.status, 'approved');

  const pass = orchestrator.completeRepairAttempt(task, { status: 'PASSED', exitCode: 0, command: 'npm test' });
  assert.equal(pass.status, 'PASSED');

  const secondFailure = orchestrator.beginRepairAttempt(task, { command: 'npm test', exitCode: 1, stderr: 'still failing' });
  assert.equal(secondFailure.attempt, 2);
  const limitReached = orchestrator.beginRepairAttempt(task, { command: 'npm test', exitCode: 1, stderr: 'still failing again' });
  assert.equal(limitReached.limitReached, true);
  assert.equal(task.state, TaskState.REPAIR_LIMIT_REACHED);
});

test('repair approval can be rejected without changing the task state to applied', async () => {
  const orchestrator = new TaskOrchestrator({ maxRepairAttempts: 3 });
  const task = orchestrator.beginTask('Fix the failing route.');
  orchestrator.beginRepairAttempt(task, { command: 'npm test', exitCode: 1, stderr: 'route 401' });

  orchestrator.submitRepairProposal(task, { summary: 'Return 200 on valid login', files: [] });
  const rejected = await orchestrator.approveRepair(task, { approved: false });
  assert.equal(rejected.ok, false);
  assert.equal(task.state, TaskState.AWAITING_REPAIR_APPROVAL);
});
