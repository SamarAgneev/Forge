import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceChangeManager } from '../src/core/workspace-changes.js';
import { createWorkspaceTools } from '../src/core/workspace-tools.js';
import { TerminalTool } from '../src/core/terminal-tool.js';
import { ProjectVerifier } from '../src/core/project-verification.js';
import { inspectProject } from '../src/core/project-inspector.js';
import { GitService } from '../src/core/git-service.js';
import { createForgeToolRegistry } from '../src/core/tool-registry.js';

test('tool registry exposes safe read/search and proposal-only write tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-tool-registry-'));
  try {
    await writeFile(join(root, 'app.js'), 'export const value = 1;\n');
    const workspaceTools = await createWorkspaceTools(root);
    const changeManager = new WorkspaceChangeManager(root);
    const terminalTool = new TerminalTool(root);
    const gitService = new GitService(root);
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    const registry = createForgeToolRegistry({
      projectMetadata: project,
      workspaceTools,
      changeManager,
      terminalTool,
      projectVerifier,
      gitService
    });

    const names = registry.list().map((tool) => tool.name);
    assert.deepEqual(names, ['project_info', 'list_directory', 'search_code', 'read_file', 'create_file', 'edit_file', 'write_file', 'run_command', 'run_commands', 'verify_project', 'git_status', 'git_diff', 'git_log', 'git_stage', 'git_commit']);
    assert.match((await registry.invoke('project_info')).summary, /forge-tool-registry-/);
    assert.equal((await registry.invoke('search_code', { query: 'value = 1' })).results[0].line, 1);
    const proposal = await registry.invoke('edit_file', {
      path: 'app.js',
      oldText: 'value = 1',
      newText: 'value = 2'
    });
    assert.equal(proposal.ok, true);
    assert.match(proposal.proposal.preview, /value = 2/);
    assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'export const value = 1;\n');
    const commandPlan = await registry.invoke('run_command', { executable: 'pwd', args: [] });
    assert.equal(commandPlan.ok, true);
    assert.match(commandPlan.plan.preview, /Allow command 1 of 1/);
    const verification = await registry.invoke('verify_project');
    assert.equal(verification.ok, true);
    assert.equal(verification.categories.tests.status, 'not-configured');
    assert.equal((await registry.invoke('not_a_tool')).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool registry exposes structured permission metadata and risk classifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-tool-permissions-'));
  try {
    const workspaceTools = await createWorkspaceTools(root);
    const changeManager = new WorkspaceChangeManager(root);
    const terminalTool = new TerminalTool(root);
    const gitService = new GitService(root);
    const project = await inspectProject({ cwd: root, limits: { rootSearchDepth: 0 } });
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    const registry = createForgeToolRegistry({
      projectMetadata: project,
      workspaceTools,
      changeManager,
      terminalTool,
      projectVerifier,
      gitService
    });

    const projectInfo = registry.getDefinition('project_info');
    const command = registry.getDefinition('run_command');
    const gitStage = registry.getDefinition('git_stage');
    const writeFile = registry.getDefinition('write_file');

    assert.equal(projectInfo.permission, 'safe');
    assert.equal(projectInfo.risk, 'low');
    assert.equal(command.permission, 'approval-required');
    assert.equal(gitStage.permission, 'approval-required');
    assert.equal(writeFile.permission, 'approval-required');
    assert.equal(writeFile.risk, 'medium');
    assert.match(JSON.stringify(projectInfo.inputSchema), /object/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});