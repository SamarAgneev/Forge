import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const REMOTE_COMMANDS = new Set(['push', 'pull', 'fetch', 'clone', 'remote']);
const DESTRUCTIVE_COMMANDS = new Set(['reset', 'clean', 'restore', 'checkout', 'rebase', 'branch', 'switch']);
const BLOCKED_DESTRUCTIVE_PATTERNS = [/^reset\b/i, /^clean\b/i, /^checkout\b/i, /^restore\b/i, /^rebase\b/i, /^branch\s+-d\b/i, /^branch\s+-D\b/i, /^switch\b/i];
const SENSITIVE_GIT_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /(^|\/)(?:credentials|secret(?:s)?|private[_ -]?keys?)(?:\/|$)/i,
  /(?:^|\/)(?:.*\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore|asc|gpg|pgp))$/i,
  /(^|\/)(?:id_[a-z0-9_]+|.*(?:rsa|dsa|ecdsa|ed25519))(?:$|\.)/i
];

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isSensitiveGitPath(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  return SENSITIVE_GIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isRemoteOperation(args) {
  const tokens = normalizeArgs(args);
  return tokens.some((token) => REMOTE_COMMANDS.has(token.toLowerCase())) || tokens.includes('push') || tokens.includes('pull') || tokens.includes('fetch') || tokens.includes('clone');
}

function isDestructiveCommand(args) {
  const tokens = normalizeArgs(args);
  if (!tokens.length) return false;
  const joined = tokens.join(' ');
  if (tokenMatches(tokens, ['reset', '--hard']) || tokenMatches(tokens, ['git', 'reset', '--hard'])) return true;
  if (tokenMatches(tokens, ['clean', '-fd']) || tokenMatches(tokens, ['git', 'clean', '-fd'])) return true;
  if (tokenMatches(tokens, ['restore', '.']) || tokenMatches(tokens, ['checkout', '--', '.'])) return true;
  if (tokenMatches(tokens, ['checkout', '--'])) return true;
  return BLOCKED_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(joined));
}

function tokenMatches(tokens, expected) {
  return tokens.length >= expected.length && expected.every((token, index) => tokens[index] === token || tokens[index] === `git` && expected[index] === 'git');
}

function parseGitStatus(rawStatus) {
  const status = {
    isRepository: true,
    branch: null,
    message: 'Git repository status detected.',
    modifiedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    untrackedFiles: [],
    stagedFiles: [],
    unstagedFiles: [],
    conflictedFiles: [],
    mergeState: null
  };

  if (!rawStatus) {
    status.message = 'Git repository is empty or no status output was returned.';
    return status;
  }

  const lines = rawStatus.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim();
      if (head && !head.startsWith('No branch')) {
        status.branch = head.split('...')[0].trim();
      }
      if (head === 'No branch') {
        status.branch = null;
      }
      continue;
    }
    if (line.startsWith('?? ')) {
      const file = line.slice(3).trim();
      if (file) status.untrackedFiles.push(file);
      continue;
    }
    if (/^UU\s|^AA\s|^DD\s|^AU\s|^UA\s|^DU\s|^UD\s|^DU\s|^UU\s/.test(line)) {
      const file = line.slice(3).trim();
      if (file) status.conflictedFiles.push(file);
      continue;
    }

    const statusCode = line.slice(0, 2);
    const fileText = line.slice(3).trim();
    if (!fileText) continue;

    const staged = statusCode[0];
    const unstaged = statusCode[1];
    const path = fileText.includes(' -> ') ? fileText.split(' -> ').at(-1).trim() : fileText;

    if (staged && staged !== ' ' && staged !== '?') status.stagedFiles.push(path);
    if (unstaged && unstaged !== ' ' && unstaged !== '?') status.unstagedFiles.push(path);

    if (staged === 'A' || unstaged === 'A') status.addedFiles.push(path);
    if (staged === 'D' || unstaged === 'D') status.deletedFiles.push(path);
    if (staged === 'R' || unstaged === 'R') status.renamedFiles.push(path);
    if (staged === 'M' || unstaged === 'M' || staged === 'T' || unstaged === 'T') status.modifiedFiles.push(path);
    if (staged === 'U' || unstaged === 'U') status.conflictedFiles.push(path);
  }

  status.modifiedFiles = [...new Set(status.modifiedFiles)];
  status.addedFiles = [...new Set(status.addedFiles)];
  status.deletedFiles = [...new Set(status.deletedFiles)];
  status.renamedFiles = [...new Set(status.renamedFiles)];
  status.untrackedFiles = [...new Set(status.untrackedFiles)];
  status.stagedFiles = [...new Set(status.stagedFiles)];
  status.unstagedFiles = [...new Set(status.unstagedFiles)];
  status.conflictedFiles = [...new Set(status.conflictedFiles)];
  status.mergeState = status.conflictedFiles.length ? 'unresolved' : 'clean';

  return status;
}

export class GitService {
  constructor(root) {
    this.root = resolve(root || process.cwd());
  }

  async run(args = []) {
    const tokens = normalizeArgs(args);
    if (!tokens.length) {
      return { ok: false, error: 'Git commands require at least one argument.' };
    }

    const lower = tokens.map((token) => String(token).toLowerCase());
    if (lower.includes('push') || lower.includes('pull') || lower.includes('fetch') || lower.includes('clone')) {
      return { ok: false, error: 'Remote Git operations are blocked in this phase. Forge does not automatically push, pull, fetch, or clone repositories.' };
    }

    if (isDestructiveCommand(tokens)) {
      return { ok: false, error: 'Destructive Git operations are blocked. Reset, clean, restore, checkout, rebase, and force branch deletion are not allowed.' };
    }

    try {
      const { stdout, stderr } = await execFileAsync('git', ['-C', this.root, ...tokens], {
        encoding: 'utf8',
        maxBuffer: 1 * 1024 * 1024,
        timeout: 15000,
        windowsHide: true
      });
      return { ok: true, stdout: stdout.trim(), stderr: (stderr || '').trim() };
    } catch (error) {
      return {
        ok: false,
        error: error?.stderr?.trim() || error?.message || 'Git command failed.',
        stdout: error?.stdout?.trim() || '',
        exitCode: error?.code ?? null,
        status: error?.status ?? null
      };
    }
  }

  async isGitRepository() {
    const result = await this.run(['rev-parse', '--show-toplevel']);
    return result.ok ? { ok: true, root: result.stdout } : { ok: false, error: 'This workspace is not a Git repository.' };
  }

  async currentBranch() {
    const result = await this.run(['branch', '--show-current']);
    if (!result.ok) {
      return { ok: false, branch: null, error: result.error };
    }
    return { ok: true, branch: result.stdout || null };
  }

  async status() {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return {
        isRepository: false,
        branch: null,
        modifiedFiles: [],
        addedFiles: [],
        deletedFiles: [],
        renamedFiles: [],
        untrackedFiles: [],
        stagedFiles: [],
        unstagedFiles: [],
        conflictedFiles: [],
        mergeState: null,
        message: 'This workspace is not a Git repository.'
      };
    }

    const statusResult = await this.run(['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
    if (!statusResult.ok) {
      return {
        isRepository: true,
        branch: null,
        modifiedFiles: [],
        addedFiles: [],
        deletedFiles: [],
        renamedFiles: [],
        untrackedFiles: [],
        stagedFiles: [],
        unstagedFiles: [],
        conflictedFiles: [],
        mergeState: null,
        message: 'Git reports a status error.'
      };
    }

    const parsed = parseGitStatus(statusResult.stdout);
    parsed.isRepository = true;
    parsed.message = parsed.conflictedFiles.length ? 'Git reports unresolved conflicts.' : 'Git status is clean.';
    parsed.root = repo.root;
    return parsed;
  }

  async diff({ file = null, staged = false, maxChars = 40_000 } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }

    const args = staged ? ['diff', '--cached'] : ['diff'];
    if (file) {
      args.push('--', file);
    }

    const result = await this.run(args);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const text = result.stdout.trim();
    if (!text) return { ok: true, text: 'No diff output.', truncated: false };
    const truncated = text.length > maxChars;
    const output = truncated ? `${text.slice(0, maxChars)}\n... [diff truncated]` : text;
    return { ok: true, text: output, truncated };
  }

  async log({ limit = 10 } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const result = await this.run(['log', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short', `-n`, String(safeLimit)]);
    if (!result.ok) return { ok: false, error: result.error };
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const commits = lines.map((line) => {
      const [hash, author, date, ...messageParts] = line.split('\t');
      return { hash, author, date, message: messageParts.join(' ') };
    });
    return { ok: true, commits };
  }

  async changedFiles() {
    const status = await this.status();
    return {
      ok: status.isRepository,
      files: [...new Set([
        ...status.modifiedFiles,
        ...status.addedFiles,
        ...status.deletedFiles,
        ...status.renamedFiles,
        ...status.untrackedFiles,
        ...status.stagedFiles,
        ...status.unstagedFiles
      ])]
    };
  }

  async stageFiles(files, { approved = false, allowAll = false } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }
    if (!Array.isArray(files) || files.length === 0) {
      return { ok: false, error: 'No file paths were provided to stage.' };
    }

    const normalized = [...new Set(files.map((file) => String(file).trim()).filter(Boolean))];
    const suspicious = normalized.filter((file) => isSensitiveGitPath(file));
    if (suspicious.length) {
      return { ok: false, error: `Sensitive files are blocked from staging by default: ${suspicious.join(', ')}` };
    }
    if (!approved && !allowAll) {
      return { ok: false, error: 'Staging requires explicit approval before any files are added.' };
    }

    const result = await this.run(['add', '--', ...normalized]);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, stagedFiles: normalized };
  }

  async unstageFiles(files, { approved = false } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }
    if (!approved) {
      return { ok: false, error: 'Unstaging requires explicit approval.' };
    }
    const normalized = [...new Set(files.map((file) => String(file).trim()).filter(Boolean))];
    const result = await this.run(['restore', '--staged', '--', ...normalized]);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, unstagedFiles: normalized };
  }

  async previewCommit({ files = [], message = null } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }

    const selected = files.length ? [...new Set(files.map((file) => String(file).trim()).filter(Boolean))] : (await this.changedFiles()).files;
    const suspicious = selected.filter((file) => isSensitiveGitPath(file));
    if (suspicious.length) {
      return { ok: false, error: `Sensitive files cannot be committed without explicit confirmation: ${suspicious.join(', ')}` };
    }

    const diffResult = await this.diff({ file: selected.length === 1 ? selected[0] : null, staged: true, maxChars: 12_000 });
    const statResult = await this.run(['diff', '--cached', '--stat', '--', ...selected]);
    const proposedMessage = message || this.generateCommitMessage(selected);

    return {
      ok: true,
      files: selected,
      stat: statResult.ok ? statResult.stdout || 'No staged diff stat.' : 'No staged diff stat available.',
      diff: diffResult.ok ? diffResult.text : 'No staged diff available.',
      proposal: {
        files: selected,
        message: proposedMessage,
        summary: `Changes ready to commit (${selected.length} file${selected.length === 1 ? '' : 's'})`
      }
    };
  }

  generateCommitMessage(files = []) {
    const fileList = [...new Set(files.filter(Boolean))];
    if (!fileList.length) return 'chore: update project files';
    const basename = fileList[0].split('/').pop() || 'project';
    return `chore: update ${basename}`;
  }

  async commit({ message, files = [], approved = false } = {}) {
    const repo = await this.isGitRepository();
    if (!repo.ok) {
      return { ok: false, error: 'This workspace is not a Git repository.' };
    }
    if (!approved) {
      return { ok: false, error: 'Commit requires explicit approval before creating a commit.' };
    }

    const selected = files.length ? [...new Set(files.map((file) => String(file).trim()).filter(Boolean))] : (await this.changedFiles()).files;
    const suspicious = selected.filter((file) => isSensitiveGitPath(file));
    if (suspicious.length) {
      return { ok: false, error: `Sensitive files cannot be staged or committed: ${suspicious.join(', ')}` };
    }

    const status = await this.status();
    if (status.conflictedFiles.length) {
      return { ok: false, error: 'Git reports unresolved conflicts. Resolve them before attempting a commit.' };
    }

    const stageResult = await this.stageFiles(selected, { approved: true });
    if (!stageResult.ok) {
      return { ok: false, error: stageResult.error };
    }

    const commitMessage = String(message || this.generateCommitMessage(selected)).trim();
    if (!commitMessage) {
      return { ok: false, error: 'A commit message is required.' };
    }

    const result = await this.run(['commit', '-m', commitMessage, '--no-gpg-sign']);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const hashResult = await this.run(['rev-parse', 'HEAD']);
    return {
      ok: true,
      message: commitMessage,
      files: selected,
      commitHash: hashResult.ok ? hashResult.stdout : null,
      output: result.stdout || 'Commit created successfully.'
    };
  }
}

export function formatGitStatus(status) {
  if (!status || !status.isRepository) {
    return 'This workspace is not a Git repository.';
  }

  const lines = [`Branch: ${status.branch || 'detached'}`];
  if (status.conflictedFiles.length) {
    lines.push('Git reports unresolved conflicts.');
    lines.push(`Conflicts: ${status.conflictedFiles.join(', ')}`);
  }
  if (status.modifiedFiles.length) {
    lines.push('Modified:');
    lines.push(...status.modifiedFiles.map((file) => `  ${file}`));
  }
  if (status.untrackedFiles.length) {
    lines.push('Untracked:');
    lines.push(...status.untrackedFiles.map((file) => `  ${file}`));
  }
  if (status.stagedFiles.length) {
    lines.push('Staged:');
    lines.push(...status.stagedFiles.map((file) => `  ${file}`));
  }
  if (status.unstagedFiles.length) {
    lines.push('Unstaged:');
    lines.push(...status.unstagedFiles.map((file) => `  ${file}`));
  }
  return lines.join('\n');
}

export function formatGitLog(log) {
  if (!log || !log.ok || !log.commits || log.commits.length === 0) {
    return 'No recent Git history to show.';
  }

  const lines = ['Recent commits:'];
  for (const commit of log.commits) {
    lines.push(`${commit.hash.slice(0, 7)} ${commit.author} ${commit.date} ${commit.message}`);
  }
  return lines.join('\n');
}
