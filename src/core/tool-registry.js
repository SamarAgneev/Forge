import { createProjectContext } from './project-inspector.js';

const TOOL_DEFINITIONS = Object.freeze({
  project_info: {
    description: 'Return detected workspace metadata without source contents.',
    permission: 'safe',
    risk: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  list_directory: {
    description: 'List safe workspace-relative entries with optional limits and filters.',
    permission: 'safe',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to inspect.' },
        maxDepth: { type: 'number', description: 'Optional depth limit.' },
        includeHidden: { type: 'boolean' },
        filter: { type: 'string' }
      },
      additionalProperties: true
    }
  },
  search_code: {
    description: 'Search bounded text files and return line-numbered snippets.',
    permission: 'safe',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or regex text.' },
        path: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'number' },
        fileExtensions: { type: 'array', items: { type: 'string' } }
      },
      required: ['query'],
      additionalProperties: true
    }
  },
  read_file: {
    description: 'Read a bounded workspace-relative text file or line range.',
    permission: 'safe',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to read.' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
        maxBytes: { type: 'number' }
      },
      required: ['path'],
      additionalProperties: true
    }
  },
  create_file: {
    description: 'Prepare a new-file proposal; this never writes without CLI approval.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirectories: { type: 'boolean' },
        summary: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: true
    }
  },
  edit_file: {
    description: 'Prepare an exact-match edit proposal; this never writes without CLI approval.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        summary: { type: 'string' }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: true
    }
  },
  write_file: {
    description: 'Prepare a guarded full-file proposal; existing files require an expected hash.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
        expectedHash: { type: 'string' },
        createDirectories: { type: 'boolean' },
        summary: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: true
    }
  },
  run_command: {
    description: 'Prepare a policy-checked command; execution always requires per-command CLI approval.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        executable: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' }
      },
      required: ['executable'],
      additionalProperties: true
    }
  },
  run_commands: {
    description: 'Prepare a bounded command sequence; every command requires separate CLI approval.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              executable: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } }
            },
            required: ['executable']
          }
        },
        summary: { type: 'string' }
      },
      required: ['commands'],
      additionalProperties: true
    }
  },
  verify_project: {
    description: 'Detect configured test, build, lint, and type-check commands without running them.',
    permission: 'safe',
    risk: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  git_status: {
    description: 'Read the Git repository status and branch safely without exposing .git internals.',
    permission: 'safe',
    risk: 'low',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }
  },
  git_diff: {
    description: 'Inspect the repository diff in a bounded, read-only way.',
    permission: 'safe',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        staged: { type: 'boolean' },
        maxChars: { type: 'number' }
      },
      additionalProperties: true
    }
  },
  git_log: {
    description: 'Show the recent repository history in a concise read-only summary.',
    permission: 'safe',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      additionalProperties: true
    }
  },
  git_stage: {
    description: 'Stage only approved, non-sensitive files after explicit confirmation.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        approved: { type: 'boolean' }
      },
      additionalProperties: true
    }
  },
  git_commit: {
    description: 'Prepare or create a commit only after explicit approval and safety checks.',
    permission: 'approval-required',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        approved: { type: 'boolean' }
      },
      required: ['message'],
      additionalProperties: true
    }
  }
});

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.definitions = new Map();
  }

  register(name, handler, metadata = {}) {
    const definition = TOOL_DEFINITIONS[name];
    if (!definition || typeof handler !== 'function') {
      throw new Error('Unknown tool or invalid handler.');
    }
    if (this.tools.has(name)) throw new Error(`Tool is already registered: ${name}`);
    this.tools.set(name, handler);
    this.definitions.set(name, { name, ...definition, ...metadata });
  }

  getDefinition(name) {
    const definition = this.definitions.get(name);
    if (!definition) return null;
    return { ...definition };
  }

  list() {
    return [...this.tools.keys()].map((name) => this.getDefinition(name));
  }

  async invoke(name, args = {}) {
    const handler = this.tools.get(name);
    if (!handler) return { ok: false, error: `Tool is not available: ${name}` };
    try {
      return await handler(args ?? {});
    } catch {
      return { ok: false, error: `Tool failed safely: ${name}` };
    }
  }
}

export function createForgeToolRegistry({ projectMetadata, workspaceTools, changeManager, terminalTool, projectVerifier, gitService } = {}) {
  const registry = new ToolRegistry();
  if (projectMetadata) {
    registry.register('project_info', async () => ({ ok: true, summary: createProjectContext(projectMetadata) }));
  }
  if (workspaceTools) {
    registry.register('list_directory', ({ path = '.', ...options }) => workspaceTools.listDirectory(path, options));
    registry.register('search_code', ({ query, ...options }) => workspaceTools.searchCode(query, options));
    registry.register('read_file', ({ path, ...options }) => workspaceTools.readFile(path, options));
  }
  if (changeManager) {
    registry.register('create_file', ({ path, content, createDirectories = false, summary }) => changeManager.createFile(path, content, { createDirectories, summary }));
    registry.register('edit_file', ({ path, oldText, newText, summary }) => changeManager.editFile(path, oldText, newText, { summary }));
    registry.register('write_file', ({ path, content, overwrite = false, expectedHash, createDirectories = false, summary }) => changeManager.writeFile(path, content, {
      overwrite,
      expectedHash,
      createDirectories,
      summary
    }));
  }
  if (terminalTool) {
    registry.register('run_command', ({ executable, args = [], summary }) => terminalTool.preparePlan({
      summary,
      commands: [{ executable, args }]
    }));
    registry.register('run_commands', ({ commands, summary }) => terminalTool.preparePlan({ commands, summary }));
  }
  if (projectVerifier) {
    registry.register('verify_project', async () => ({ ok: true, ...(await projectVerifier.detectCommands()) }));
  }
  if (gitService) {
    registry.register('git_status', async () => gitService.status());
    registry.register('git_diff', async ({ file = null, staged = false, maxChars = 40_000 } = {}) => gitService.diff({ file, staged, maxChars }));
    registry.register('git_log', async ({ limit = 10 } = {}) => gitService.log({ limit }));
    registry.register('git_stage', async ({ files = [], approved = false } = {}) => gitService.stageFiles(files, { approved }));
    registry.register('git_commit', async ({ message, files = [], approved = false } = {}) => gitService.commit({ message, files, approved }));
  }
  return registry;
}