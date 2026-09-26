#!/usr/bin/env node
import 'dotenv/config';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Conversation } from '../core/conversation.js';
import { ConfigurationError, createModelProvider, getModelStatus, loadConfig } from '../core/config.js';
import { inspectProject } from '../core/project-inspector.js';
import { WorkspaceChangeManager } from '../core/workspace-changes.js';
import { createWorkspaceTools } from '../core/workspace-tools.js';
import { createForgeToolRegistry } from '../core/tool-registry.js';
import { createTerminalTool } from '../core/terminal-tool.js';
import { ProjectVerifier } from '../core/project-verification.js';
import { TaskOrchestrator } from '../core/task-orchestrator.js';
import { GitService } from '../core/git-service.js';
import { runRepl } from './repl.js';

const { version } = createRequire(import.meta.url)('../../package.json');
const HELP_TEXT = `Forge ${version} - Open-source AI coding agent

Usage:
  forge             Start an interactive conversation
  forge --help      Show this help message
  forge --version   Show the Forge version
  forge --model     Show the active provider and model

Configure a provider before starting. Supported providers: openai, local.
Set OPENAI_API_KEY for OpenAI or MODEL_NAME + MODEL_BASE_URL for a local endpoint.
Set FORGE_MODEL to choose a model, and FORGE_COMMAND_TIMEOUT_MS to adjust the bounded command timeout.
`;

export async function main({
  args = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr
} = {}) {
  const option = args[0];
  if (option === '--help' || option === '-h') {
    output.write(HELP_TEXT);
    return 0;
  }
  if (option === '--version' || option === '-v') {
    output.write(`${version}\n`);
    return 0;
  }
  if (option === '--model') {
    try {
      const config = loadConfig(env);
      const status = getModelStatus(config);
      output.write(`Current provider: ${status.provider}\nCurrent model: ${status.model}\nAvailable configured models: ${status.available.join(', ')}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ConfigurationError) {
        errorOutput.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }
  if (option) {
    errorOutput.write(`Forge: Unknown option "${option}". Run forge --help for usage.\n`);
    return 1;
  }

  try {
    const config = loadConfig(env);
    const project = await inspectProject();
    const workspaceTools = await createWorkspaceTools(project.projectRoot);
    const changeManager = new WorkspaceChangeManager(workspaceTools.root);
    const configuredTimeout = env.FORGE_COMMAND_TIMEOUT_MS?.trim();
    const terminalTool = await createTerminalTool(project.projectRoot, {
      timeoutMs: configuredTimeout ? Number(configuredTimeout) : undefined
    });
    const gitService = new GitService(project.projectRoot);
    const projectVerifier = new ProjectVerifier(project, workspaceTools, terminalTool);
    const taskOrchestrator = new TaskOrchestrator({ projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, maxRepairAttempts: config.maxRepairAttempts });
    const toolRegistry = createForgeToolRegistry({ projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, gitService });
    const provider = createModelProvider(config);
    const conversation = new Conversation(provider, { projectMetadata: project, workspaceTools, changeManager, terminalTool, projectVerifier, toolRegistry, taskOrchestrator, gitService });
    await runRepl({ conversation, input, output, model: config.model, providerName: provider.providerName, project, debug: env.FORGE_DEBUG === '1' });
    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      errorOutput.write(`${error.message}\n`);
    } else if (env.FORGE_DEBUG === '1' && error instanceof Error) {
      errorOutput.write(`Forge: ${error.message}\n`);
    } else {
      errorOutput.write('Forge could not start. Set FORGE_DEBUG=1 for details.\n');
    }
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((status) => {
    process.exitCode = status;
  });
}
