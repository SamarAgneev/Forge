import { inspectProject } from '../core/project-inspector.js';
import { Conversation } from '../core/conversation.js';
import { createModelProvider, loadConfig } from '../core/config.js';
import { WorkspaceChangeManager } from '../core/workspace-changes.js';
import { createWorkspaceTools } from '../core/workspace-tools.js';
import { createForgeToolRegistry } from '../core/tool-registry.js';
import { createTerminalTool } from '../core/terminal-tool.js';
import { ProjectVerifier } from '../core/project-verification.js';
import { TaskOrchestrator } from '../core/task-orchestrator.js';
import { GitService } from '../core/git-service.js';
import { ForgeFrontendBridge } from './event-protocol.js';

export async function createForgeSession({ env = process.env, workingDirectory = process.cwd() } = {}) {
  const config = loadConfig(env);
  const project = await inspectProject({ cwd: workingDirectory });
  const workspaceTools = await createWorkspaceTools(project.projectRoot);
  const changeManager = new WorkspaceChangeManager(workspaceTools.root);
  const terminalTool = await createTerminalTool(project.projectRoot, {
    timeoutMs: env.FORGE_COMMAND_TIMEOUT_MS ? Number(env.FORGE_COMMAND_TIMEOUT_MS) : undefined
  });
  const gitService = new GitService(project.projectRoot);
  const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
  const taskOrchestrator = new TaskOrchestrator({
    projectMetadata: project,
    workspaceTools,
    changeManager,
    terminalTool,
    projectVerifier,
    maxRepairAttempts: config.maxRepairAttempts
  });
  const toolRegistry = createForgeToolRegistry({
    projectMetadata: project,
    workspaceTools,
    changeManager,
    terminalTool,
    projectVerifier,
    gitService
  });
  const provider = createModelProvider(config);
  const conversation = new Conversation(provider, {
    projectMetadata: project,
    workspaceTools,
    changeManager,
    terminalTool,
    projectVerifier,
    toolRegistry,
    taskOrchestrator,
    gitService
  });

  const bridge = new ForgeFrontendBridge({ conversation, onEvent: () => {} });

  return {
    config,
    project,
    workspaceTools,
    changeManager,
    terminalTool,
    gitService,
    projectVerifier,
    taskOrchestrator,
    toolRegistry,
    provider,
    conversation,
    bridge
  };
}
