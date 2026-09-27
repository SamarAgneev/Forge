import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { WorkspacePolicy, redactSensitiveValues } from './workspace-policy.js';

const DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  killGraceMs: 1000,
  maxStdoutBytes: 48 * 1024,
  maxStderrBytes: 24 * 1024,
  maxTotalOutputBytes: 64 * 1024,
  maxCommandsPerPlan: 5
});
const SHELL_METACHARACTERS = /[;&|<>`$()\r\n\u0000]/;
const BLOCKED_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wscript', 'cscript', 'taskkill', 'format', 'diskpart', 'reg', 'reg.exe', 'sudo', 'su', 'doas', 'ssh', 'scp', 'sftp'
]);
const BLOCKED_GIT_COMMANDS = new Set([
  'add', 'apply', 'branch', 'checkout', 'clean', 'clone', 'commit', 'fetch', 'merge', 'pull', 'push',
  'rebase', 'reset', 'restore', 'rm', 'stash', 'switch', 'tag', 'worktree'
]);
const DESTRUCTIVE_EXECUTABLES = new Set(['rm', 'rmdir', 'del', 'erase', 'dd', 'mkfs', 'shutdown', 'reboot', 'diskpart', 'format']);
const SAFE_NPM_SCRIPTS = new Set(['test', 'build', 'lint', 'check', 'typecheck']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const VERIFICATION_CATEGORIES = new Set(['tests', 'typecheck', 'build', 'lint']);
const VERIFICATION_LABELS = Object.freeze({ tests: 'Tests', typecheck: 'Type Check', build: 'Build', lint: 'Lint' });
const ENVIRONMENT_KEYS = process.platform === 'win32'
  ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC']
  : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];

function clamp(value, minimum, maximum, fallback) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

function cleanText(value, maximum = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum);
}

function sanitizeCommandOutput(value) {
  return redactSensitiveValues(String(value ?? ''))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function displayCommand(executable, args) {
  return [executable, ...args].map((part) => /^[\w./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part)).join(' ');
}

function normalizeCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, error: 'Commands must use a structured executable and argument list.' };
  }
  const executable = typeof command.executable === 'string' ? command.executable.trim().toLowerCase() : '';
  const args = command.args === undefined ? [] : command.args;
  if (!executable || !Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string')) {
    return { ok: false, error: 'Invalid executable or argument list.' };
  }
  if (/[\\/]/.test(executable) || executable.includes(':') || BLOCKED_EXECUTABLES.has(executable)) {
    return { ok: false, error: 'Shells, executable paths, and system-level commands are blocked.' };
  }
  if (args.some((arg) => SHELL_METACHARACTERS.test(arg) || arg.length > 1024)) {
    return { ok: false, error: 'Shell operators, substitutions, control characters, or oversized arguments are blocked.' };
  }
  if (args.some((arg) => isAbsolute(arg) || win32.isAbsolute(arg) || /(^|[\\/])\.\.([\\/]|$)/.test(arg))) {
    return { ok: false, error: 'Command arguments cannot reference paths outside the workspace.' };
  }
  return { ok: true, executable, args: [...args] };
}

export class CommandPolicy {
  classify(command) {
    const requestedExecutable = typeof command?.executable === 'string' ? command.executable.trim().toLowerCase() : '';
    const requestedArgs = Array.isArray(command?.args) ? command.args : [];
    if (DESTRUCTIVE_EXECUTABLES.has(requestedExecutable)
      || (requestedExecutable === 'git' && BLOCKED_GIT_COMMANDS.has(requestedArgs[0]))) {
      return {
        ok: false,
        executable: requestedExecutable,
        args: requestedArgs,
        disposition: 'blocked',
        category: 'potentially-destructive',
        error: `${requestedExecutable === 'git' ? `Git ${requestedArgs[0]}` : requestedExecutable} is blocked by Forge command policy.`
      };
    }
    const normalized = normalizeCommand(command);
    if (!normalized.ok) return { ...normalized, disposition: 'blocked', category: 'blocked' };
    const { executable, args } = normalized;
    let category = 'blocked';

    if (executable === 'pwd' && args.length === 0) {
      category = 'read-only';
    } else if (['node', 'node.exe'].includes(executable) && args.length === 1 && args[0] === '--version') {
      category = 'read-only';
    } else if (['python', 'python3', 'py'].includes(executable) && args.length === 1 && ['--version', '-V'].includes(args[0])) {
      category = 'read-only';
    } else if (PACKAGE_MANAGERS.has(executable) && args.length === 1 && args[0] === '--version') {
      category = 'read-only';
    } else if (executable === 'git' && args[0] === 'status' && (args.length === 1 || (args.length === 2 && args[1] === '--short'))) {
      category = 'read-only';
    } else if (executable === 'git' && args[0] === 'diff' && (args.length === 1 || (args.length === 2 && ['--stat', '--check', '--name-only'].includes(args[1])))) {
      category = 'read-only';
    } else if (PACKAGE_MANAGERS.has(executable) && (args.length === 1 && SAFE_NPM_SCRIPTS.has(args[0])
      || args.length === 2 && args[0] === 'run' && SAFE_NPM_SCRIPTS.has(args[1]))) {
      category = 'development';
    } else if (['pytest'].includes(executable) && args.length === 0) {
      category = 'development';
    } else if (['python', 'python3', 'py'].includes(executable) && args.length === 2 && args[0] === '-m' && args[1] === 'pytest') {
      category = 'development';
    } else if (executable === 'cargo' && args.length === 1 && args[0] === 'test') {
      category = 'development';
    } else if (executable === 'cargo' && args.length === 1 && ['build', 'check', 'clippy'].includes(args[0])) {
      category = 'development';
    } else if (executable === 'go' && ['test', 'vet', 'build'].includes(args[0]) && args.length === 2 && args[1] === './...') {
      category = 'development';
    } else if (executable === 'go' && args.length === 1 && args[0] === 'test') {
      category = 'development';
    } else if (['mvn', 'mvnw'].includes(executable) && args.length === 1 && ['test', 'package', 'verify'].includes(args[0])) {
      category = 'development';
    } else if (['gradle'].includes(executable) && args.length === 1 && ['test', 'build', 'check'].includes(args[0])) {
      category = 'development';
    } else if (executable === 'ruff' && args.length === 1 && args[0] === 'check') {
      category = 'development';
    } else if (executable === 'mypy' && args.length === 0) {
      category = 'development';
    }

    if (category === 'blocked') {
      const dangerousCommand = executable === 'git' && BLOCKED_GIT_COMMANDS.has(args[0])
        ? `Git ${args[0]} is not available through Forge.`
        : 'This command is outside Forge\'s conservative allowlist.';
      return { ok: false, executable, args, disposition: 'blocked', category, error: dangerousCommand };
    }
    return {
      ok: true,
      executable,
      args,
      category,
      disposition: 'requires-approval',
      display: displayCommand(executable, args)
    };
  }

  preparePlan(commands) {
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > DEFAULTS.maxCommandsPerPlan) {
      return { ok: false, error: `A command plan must contain between 1 and ${DEFAULTS.maxCommandsPerPlan} commands.` };
    }
    const classified = commands.map((command) => this.classify(command));
    const blocked = classified.find((result) => !result.ok);
    if (blocked) return { ok: false, error: blocked.error, blockedCommand: blocked.display ?? null };
    return { ok: true, commands: classified };
  }
}

function safeEnvironment() {
  const environment = {};
  for (const key of ENVIRONMENT_KEYS) {
    const actualKey = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === key);
    if (actualKey && process.env[actualKey] !== undefined) environment[actualKey] = process.env[actualKey];
  }
  return environment;
}

async function findNpmCli(workspaceRoot) {
  const candidates = new Set();
  const executableDirectory = dirname(process.execPath);
  candidates.add(join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.add(resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (process.env.PROGRAMFILES) candidates.add(join(process.env.PROGRAMFILES, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (process.env.npm_execpath?.toLowerCase().endsWith('npm-cli.js')) candidates.add(resolve(process.env.npm_execpath));
  for (const pathEntry of (process.env.PATH ?? '').split(delimiter)) {
    if (!pathEntry) continue;
    candidates.add(join(pathEntry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.add(resolve(pathEntry, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (isWithinWorkspace(workspaceRoot, canonical)) continue;
      await access(canonical, constants.R_OK);
      return canonical;
    } catch {
      // Try the next standard Node/npm installation layout.
    }
  }
  return null;
}

function isWithinWorkspace(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function capChunks(chunks, chunk, maximum, budget) {
  const available = Math.max(0, Math.min(maximum - budget.used, budget.totalRemaining));
  if (available <= 0) {
    budget.truncated = true;
    return;
  }
  const accepted = chunk.subarray(0, available);
  chunks.push(accepted);
  budget.used += accepted.length;
  budget.totalRemaining -= accepted.length;
  if (accepted.length < chunk.length) budget.truncated = true;
}

export class TerminalTool {
  constructor(workspaceRoot, { currentWorkingDirectory, timeoutMs = DEFAULTS.timeoutMs, limits = {}, commandPolicy, spawnImplementation = spawn } = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.currentWorkingDirectory = resolve(currentWorkingDirectory ?? workspaceRoot);
    this.policy = new WorkspacePolicy(this.workspaceRoot);
    this.commandPolicy = commandPolicy ?? new CommandPolicy();
    this.spawnImplementation = spawnImplementation;
    this.timeoutMs = clamp(timeoutMs, 100, DEFAULTS.maxTimeoutMs, DEFAULTS.timeoutMs);
    this.limits = {
      maxStdoutBytes: clamp(limits.maxStdoutBytes, 256, 1024 * 1024, DEFAULTS.maxStdoutBytes),
      maxStderrBytes: clamp(limits.maxStderrBytes, 256, 1024 * 1024, DEFAULTS.maxStderrBytes),
      maxTotalOutputBytes: clamp(limits.maxTotalOutputBytes, 512, 2 * 1024 * 1024, DEFAULTS.maxTotalOutputBytes),
      killGraceMs: clamp(limits.killGraceMs, 50, 10_000, DEFAULTS.killGraceMs)
    };
    this.plans = new Map();
  }

  async preparePlan(request, { internalVerification = false } = {}) {
    const prepared = this.commandPolicy.preparePlan(request?.commands);
    if (!prepared.ok) return prepared;
    for (const command of prepared.commands) {
      const available = await this.isCommandAvailable(command);
      if (!available) return { ok: false, error: `Configured command is unavailable: ${command.display}.` };
    }
    const id = randomUUID();
    const plan = {
      id,
      summary: cleanText(request.summary || 'Run the requested development command(s).', 200),
      commands: prepared.commands.map(({ executable, args, display, category }, index) => {
        const verificationCategory = internalVerification && VERIFICATION_CATEGORIES.has(request.commands[index]?.verificationCategory)
          ? request.commands[index].verificationCategory
          : null;
        return { executable, args, display, category, verificationCategory };
      }),
      index: 0,
      results: []
    };
    this.plans.set(id, plan);
    const preview = [
      `Forge wants to run: ${plan.summary}`,
      ...plan.commands.map((command, index) => `${index + 1}. ${command.verificationCategory ? `${VERIFICATION_LABELS[command.verificationCategory]}: ` : ''}${command.display} [${command.category}]`),
      '',
      `Allow command 1 of ${plan.commands.length}? [y/N]`
    ].join('\n');
    return {
      ok: true,
      plan: {
        id,
        summary: plan.summary,
        commands: plan.commands.map(({ display, category, verificationCategory }) => ({ command: display, category, verificationCategory })),
        verification: internalVerification,
        preview
      }
    };
  }

  cancelPlan(id) {
    const cancelled = this.plans.delete(id);
    return { ok: cancelled, cancelled };
  }

  async runCommand(command, options = {}) {
    const classification = this.commandPolicy.classify(command);
    if (!classification.ok) return { ok: false, blocked: true, error: classification.error };
    if (options.approved !== true) {
      return { ok: false, requiresApproval: true, command: classification.display, category: classification.category };
    }
    const result = await this.execute(classification, options);
    return { ok: result.started === true, success: result.started === true && result.exitCode === 0 && !result.timedOut, ...result };
  }

  async isCommandAvailable(command) {
    if (command.executable === 'pwd' || ['node', 'node.exe'].includes(command.executable)) return true;
    if (command.executable === 'npm') return Boolean(await findNpmCli(this.workspaceRoot));
    if (['pnpm', 'yarn', 'bun'].includes(command.executable)) return Boolean(await this.resolveExecutable(command.executable));
    let executable = command.executable;
    if (executable === 'pytest') executable = process.platform === 'win32' ? 'python' : 'python3';
    return Boolean(await this.resolveExecutable(executable));
  }

  async approveNext(id, { approved = false } = {}) {
    const plan = this.plans.get(id);
    if (!plan) return { ok: false, error: 'Command plan is no longer pending.' };
    if (approved !== true) return { ok: false, error: 'Explicit command approval is required.' };
    const command = plan.commands[plan.index];
    const classification = this.commandPolicy.classify({ executable: command.executable, args: command.args });
    if (!classification.ok) {
      this.plans.delete(id);
      return { ok: false, blocked: true, error: classification.error };
    }
    const result = await this.execute(classification);
    plan.results.push(result);
    plan.index += 1;
    const complete = plan.index >= plan.commands.length;
    if (complete) this.plans.delete(id);
    return {
      ok: true,
      result,
      complete,
      remaining: complete ? 0 : plan.commands.length - plan.index,
      nextCommand: complete ? null : plan.commands[plan.index].display,
      results: [...plan.results]
    };
  }

  async execute(classification, { timeoutMs } = {}) {
    const cwd = await this.resolveWorkingDirectory();
    if (!cwd.ok) return this.resultBase(classification.display, null, cwd.error);
    const start = performance.now();
    if (classification.executable === 'pwd') {
      return {
        started: true,
        success: true,
        command: classification.display,
        workingDirectory: cwd.relativePath,
        stdout: `${cwd.path}\n`,
        stderr: '',
        exitCode: 0,
        durationMs: Math.round(performance.now() - start),
        timedOut: false,
        outputTruncated: false
      };
    }

    let executable = classification.executable;
    let args = classification.args;
    if (['node', 'node.exe'].includes(executable) && args[0] === '--version') {
      executable = process.execPath;
      args = ['--version'];
    } else if (executable === 'npm') {
      const npmCli = await findNpmCli(this.workspaceRoot);
      if (!npmCli) return this.resultBase(classification.display, cwd.path, 'npm was approved but its JavaScript CLI could not be located safely.');
      executable = process.execPath;
      args = [npmCli, ...args];
    } else if (executable === 'pytest') {
      executable = process.platform === 'win32' ? 'python' : 'python3';
      args = ['-m', 'pytest'];
    }

    if (executable !== process.execPath) {
      const resolvedExecutable = await this.resolveExecutable(executable);
      if (!resolvedExecutable) {
        return this.resultBase(classification.display, cwd.path, `Approved executable was not found outside the workspace: ${executable}.`);
      }
      executable = resolvedExecutable;
    }

    const environment = safeEnvironment();
    const stdoutChunks = [];
    const stderrChunks = [];
    const budget = {
      used: 0,
      totalRemaining: this.limits.maxTotalOutputBytes,
      stdoutUsed: 0,
      stderrUsed: 0,
      truncated: false
    };
    let timedOut = false;
    let spawnError = null;
    let forceKillTimer = null;
    const duration = clamp(timeoutMs, 100, DEFAULTS.maxTimeoutMs, this.timeoutMs);
    const child = this.spawnImplementation(executable, args, {
      cwd: cwd.path,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const startedAt = performance.now();

    const handleOutput = (stream, chunks, maximum, key) => {
      stream.on('data', (chunk) => {
        const priorUsed = budget.used;
        capChunks(chunks, chunk, maximum, budget);
        const accepted = budget.used - priorUsed;
        budget[key] += accepted;
      });
    };
    handleOutput(child.stdout, stdoutChunks, this.limits.maxStdoutBytes, 'stdoutUsed');
    handleOutput(child.stderr, stderrChunks, this.limits.maxStderrBytes, 'stderrUsed');

    const commandResult = await new Promise((resolveResult) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminateProcessTree(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => this.terminateProcessTree(child, 'SIGKILL'), this.limits.killGraceMs);
        forceKillTimer.unref?.();
      }, duration);

      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolveResult(exitCode);
      });
    });

    let stdout = sanitizeCommandOutput(Buffer.concat(stdoutChunks).toString('utf8'));
    let stderr = sanitizeCommandOutput(Buffer.concat(stderrChunks).toString('utf8'));
    if (budget.truncated) {
      const marker = '\n[output truncated]\n';
      if (stdout && budget.stdoutUsed >= budget.stderrUsed) stdout += marker;
      else stderr += marker;
    }
    if (spawnError) stderr = redactSensitiveValues(`Command could not be started: ${spawnError.code ?? 'process error'}`);
    return {
      started: !spawnError,
      command: classification.display,
      workingDirectory: cwd.relativePath,
      stdout,
      stderr,
      exitCode: spawnError ? null : commandResult,
      durationMs: Math.round(performance.now() - startedAt),
      timedOut,
      outputTruncated: budget.truncated
    };
  }

  async resolveWorkingDirectory() {
    const candidate = resolve(this.currentWorkingDirectory);
    const relativePath = relative(this.workspaceRoot, candidate);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { ok: false, error: 'Command working directory is outside the workspace.' };
    }
    const canonicalRoot = await realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
    const canonicalPath = await realpath(candidate).catch(() => null);
    if (!canonicalPath) return { ok: false, error: 'Command working directory is unavailable.' };
    const canonicalRelative = relative(canonicalRoot, canonicalPath);
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
      return { ok: false, error: 'Command working directory is outside the workspace.' };
    }
    if (canonicalRelative && await this.policy.isPathIgnored(canonicalRelative, true)) {
      return { ok: false, error: 'Command working directory is ignored by workspace rules.' };
    }
    return {
      ok: true,
      path: canonicalPath,
      relativePath: canonicalRelative.split(sep).join('/') || '.'
    };
  }

  async resolveExecutable(executable) {
    const pathEntries = (safeEnvironment().PATH ?? '').split(delimiter).filter(Boolean);
    const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
    for (const directory of pathEntries) {
      const canonicalDirectory = await realpath(directory).catch(() => null);
      if (!canonicalDirectory || isWithinWorkspace(this.workspaceRoot, canonicalDirectory)) continue;
      for (const extension of extensions) {
        const candidate = resolve(canonicalDirectory, `${executable}${extension}`);
        try {
          const canonical = await realpath(candidate);
          if (isWithinWorkspace(this.workspaceRoot, canonical)) continue;
          await access(canonical, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
          return canonical;
        } catch {
          // Continue searching trusted PATH entries for this allow-listed executable.
        }
      }
    }
    return null;
  }

  resultBase(command, workingDirectory, error) {
    return {
      started: false,
      command,
      workingDirectory,
      stdout: '',
      stderr: cleanText(error),
      error: cleanText(error),
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      outputTruncated: false
    };
  }

  terminateProcessTree(child, signal) {
    if (process.platform === 'win32' && child.pid && process.env.SystemRoot) {
      const taskkill = join(process.env.SystemRoot, 'System32', 'taskkill.exe');
      const args = ['/PID', String(child.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      try {
        const killer = spawn(taskkill, args, {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH ?? '' }
        });
        killer.unref();
        return;
      } catch {
        // Fall back to terminating the direct child if taskkill is unavailable.
      }
    }
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to terminating the direct child if its process group is gone.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export async function createTerminalTool(workspaceRoot, options = {}) {
  const root = await realpath(resolve(workspaceRoot));
  return new TerminalTool(root, options);
}

export function parseCommandPlanResponse(response) {
  const openingTag = /<forge-command-plan>/i.exec(response);
  const closingTagIndex = response.toLowerCase().lastIndexOf('</forge-command-plan>');
  if (!openingTag || closingTagIndex < openingTag.index + openingTag[0].length) return null;
  try {
    const plan = JSON.parse(response.slice(openingTag.index + openingTag[0].length, closingTagIndex).trim());
    return plan && Array.isArray(plan.commands) ? plan : null;
  } catch {
    return null;
  }
}

export function isCommandRequest(prompt) {
  return /\b(run|execute|start)\b[\s\S]{0,100}\b(tests?|build|lint|pytest|cargo|npm|go test|git status|git diff|version)\b/i.test(prompt)
    || /\b(?:build|lint|typecheck|pytest)\s*(?:please|for me)?$/i.test(prompt)
    || /^\s*(?:npm|pytest|cargo|go test|git status|git diff)\b/i.test(prompt);
}

export function commandPlanInstructions() {
  return [
    'The user asked to run a development command. Forge may only propose commands; the CLI will show the complete sequence and require separate explicit approval for each command.',
    'Return exactly one <forge-command-plan> JSON block: {"summary":"short purpose","commands":[{"executable":"npm","args":["test"]}]}.',
    'Commands are structured argv, never a shell string. Do not use shell operators, shell programs, scripts, commands outside the supported safe policy, arbitrary code, paths outside the workspace, environment dumps, package installation, database mutation, or Git writes. If the request cannot be represented by supported commands, explain that rather than proposing a workaround.',
    'Supported examples: npm test; npm run build/lint/check/typecheck; pytest; python -m pytest; cargo test; go test ./...; git status [--short]; git diff [--stat|--check|--name-only]; node/python/npm --version; pwd.',
    'Do not claim a command ran. No command may execute before its own y/yes approval.'
  ].join('\n');
}