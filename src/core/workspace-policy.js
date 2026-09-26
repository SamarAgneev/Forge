import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const IGNORE_FILES = ['.gitignore', '.ignore', '.forgeignore'];
const IGNORE_FILE_LIMIT = 16 * 1024;
const DEFAULT_IGNORE_BUDGET = 64 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', 'out',
  '.next', '.nuxt', '.output', '.svelte-kit', '.venv', 'venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.cache', '.turbo', '.gradle', 'bin', 'obj'
]);
const SENSITIVE_DIRECTORIES = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.config', '.docker', 'gcloud'
]);

export function isSensitiveName(name) {
  const lowerName = name.toLowerCase();
  return lowerName.startsWith('.env')
    || lowerName === '.npmrc'
    || lowerName === '.pypirc'
    || lowerName === '.netrc'
    || lowerName === 'credentials'
    || lowerName.includes('secret')
    || lowerName.includes('credential')
    || lowerName.includes('token')
    || /service[-_]account/i.test(name)
    || /private[-_]?key/i.test(name)
    || /ssh[-_].*key/i.test(name)
    || /\.tfstate(?:\.backup)?$/i.test(name)
    || /\.tfvars$/i.test(name)
    || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)
    || /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|asc|gpg|pgp)$/i.test(name);
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globExpression(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`^${expression}$`);
}

function parseIgnoreRules(text, basePath) {
  return text.split(/\r?\n/).flatMap((line) => {
    let pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) return [];
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);
    if (!pattern) return [];

    const anchored = pattern.startsWith('/');
    const directoryOnly = pattern.endsWith('/');
    pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (!pattern) return [];
    return [{
      anchored,
      basePath,
      directoryOnly,
      hasSlash: pattern.includes('/'),
      negated,
      expression: globExpression(pattern)
    }];
  });
}

function ruleMatches(rule, relativePath, isDirectory) {
  const scopedPath = relative(rule.basePath, relativePath).split(sep).join('/');
  if (scopedPath === '..' || scopedPath.startsWith('../')) return false;
  if (rule.directoryOnly && !isDirectory) return false;
  if (rule.hasSlash || rule.anchored) return rule.expression.test(scopedPath);
  return scopedPath.split('/').some((segment) => rule.expression.test(segment));
}

async function readBoundedIgnore(filePath, state) {
  const allowance = Math.min(IGNORE_FILE_LIMIT, state.remainingBytes);
  if (allowance <= 0) return '';

  let handle;
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) return '';
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(allowance + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const usedBytes = Math.min(bytesRead, allowance);
    state.remainingBytes -= usedBytes;
    const text = buffer.subarray(0, usedBytes).toString('utf8');
    return bytesRead > allowance ? text.slice(0, text.lastIndexOf('\n')) : text;
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathSegments(path) {
  return String(path).replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.');
}

function isWithinRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

export class WorkspacePolicy {
  constructor(root, { state = { remainingBytes: DEFAULT_IGNORE_BUDGET } } = {}) {
    this.root = resolve(root);
    this.state = state;
    this.ruleCache = new Map();
  }

  isSensitiveName(name) {
    return isSensitiveName(name);
  }

  isSensitivePath(path) {
    return pathSegments(path).some((segment) => isSensitiveName(segment) || SENSITIVE_DIRECTORIES.has(segment.toLowerCase()));
  }

  isExcludedDirectoryName(name) {
    const normalizedName = name.toLowerCase();
    return EXCLUDED_DIRECTORIES.has(normalizedName) || SENSITIVE_DIRECTORIES.has(normalizedName);
  }

  isProtectedPath(path) {
    return this.isSensitivePath(path) || pathSegments(path).some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLowerCase()));
  }

  isIgnored(path, isDirectory, rules) {
    let ignored = false;
    for (const rule of rules) {
      if (ruleMatches(rule, path, isDirectory)) ignored = !rule.negated;
    }
    return ignored;
  }

  async rulesForDirectory(relativeDirectory = '') {
    const segments = pathSegments(relativeDirectory);
    if (segments.includes('..') || segments.some((segment) => this.isProtectedPath(segment))) return [];

    if (!this.ruleCache.has('')) {
      this.ruleCache.set('', await this.readLocalRules(this.root, ''));
    }
    let currentPath = '';
    let rules = this.ruleCache.get('');
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}${sep}${segment}` : segment;
      if (this.ruleCache.has(currentPath)) {
        rules = this.ruleCache.get(currentPath);
        continue;
      }
      const absoluteDirectory = resolve(this.root, currentPath);
      const localRules = await this.readLocalRules(absoluteDirectory, currentPath);
      rules = [...rules, ...localRules];
      this.ruleCache.set(currentPath, rules);
    }
    return rules;
  }

  async readLocalRules(directory, relativeDirectory) {
    const rules = [];
    for (const name of IGNORE_FILES) {
      const text = await readBoundedIgnore(resolve(directory, name), this.state);
      rules.push(...parseIgnoreRules(text, relativeDirectory));
    }
    return rules;
  }

  async isPathIgnored(path, isDirectory = false) {
    const segments = pathSegments(path);
    if (!segments.length) return false;
    let candidate = '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      candidate = candidate ? `${candidate}${sep}${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      const parent = dirname(candidate);
      const parentPath = parent === '.' ? '' : parent;
      const rules = await this.rulesForDirectory(parentPath);
      if (this.isIgnored(candidate, isLeaf ? isDirectory : true, rules)) return true;
    }
    return false;
  }

  async resolvePath(input) {
    if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) {
      return { ok: false, error: 'Invalid workspace-relative path.' };
    }
    const rawPath = input.trim();
    if (!rawPath || isAbsolute(rawPath) || win32.isAbsolute(rawPath) || /^[a-z]:/i.test(rawPath)) {
      return { ok: false, error: 'Use a path relative to the workspace.' };
    }
    const segments = pathSegments(rawPath);
    if (segments.includes('..')) return { ok: false, error: 'Path traversal is not allowed.' };
    if (segments.some((segment) => segment.includes(':'))) return { ok: false, error: 'Invalid workspace-relative path.' };
    const relativePath = segments.join('/');
    if (this.isProtectedPath(relativePath)) return { ok: false, error: 'This path is protected and cannot be inspected.' };

    let absolutePath = this.root;
    try {
      for (const segment of segments) {
        absolutePath = resolve(absolutePath, segment);
        const details = await lstat(absolutePath);
        if (details.isSymbolicLink()) return { ok: false, error: 'Symbolic links cannot be inspected.' };
        if (absolutePath !== this.root && !isWithinRoot(this.root, absolutePath)) {
          return { ok: false, error: 'Path is outside the workspace.' };
        }
      }
      const details = await lstat(absolutePath);
      const canonicalPath = await realpath(absolutePath);
      if (!isWithinRoot(this.root, canonicalPath)) return { ok: false, error: 'Path is outside the workspace.' };
      return { ok: true, path: relativePath || '.', absolutePath, details };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return { ok: false, path: relativePath, error: 'File or directory was not found.' };
      }
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        return { ok: false, path: relativePath, error: 'Permission denied.' };
      }
      return { ok: false, path: relativePath, error: 'Path could not be inspected.' };
    }
  }

  async resolveTargetPath(input, { allowMissingParents = false, allowSensitive = false, allowIgnored = false } = {}) {
    if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) {
      return { ok: false, error: 'Invalid workspace-relative path.' };
    }
    const rawPath = input.trim();
    if (!rawPath || isAbsolute(rawPath) || win32.isAbsolute(rawPath) || /^[a-z]:/i.test(rawPath)) {
      return { ok: false, error: 'Use a path relative to the workspace.' };
    }

    const segments = pathSegments(rawPath);
    if (!segments.length || segments.includes('..') || segments.some((segment) => segment.includes(':'))) {
      return { ok: false, error: 'Invalid or traversing workspace-relative path.' };
    }
    if (segments.slice(0, -1).some((segment) => this.isProtectedPath(segment))) {
      return { ok: false, error: 'Protected directories cannot be modified.' };
    }
    const targetName = segments.at(-1);
    if (this.isExcludedDirectoryName(targetName)) {
      return { ok: false, error: 'Protected directories cannot be modified.' };
    }
    if (this.isSensitiveName(targetName) && !allowSensitive) {
      return { ok: false, error: 'Sensitive files require explicit protected-file confirmation.' };
    }

    const relativePath = segments.join('/');
    const absolutePath = resolve(this.root, ...segments);
    let currentPath = this.root;
    let details = null;
    let missingSegments = [];
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const nextPath = resolve(currentPath, segments[index]);
        try {
          details = await lstat(nextPath);
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
          missingSegments = segments.slice(index);
          if (index < segments.length - 1 && !allowMissingParents) {
            return { ok: false, path: relativePath, error: 'Parent directories do not exist; directory creation was not enabled.' };
          }
          details = null;
          break;
        }
        if (details.isSymbolicLink()) return { ok: false, path: relativePath, error: 'Symbolic links cannot be modified.' };
        if (index < segments.length - 1 && !details.isDirectory()) {
          return { ok: false, path: relativePath, error: 'A parent path component is not a directory.' };
        }
        currentPath = nextPath;
      }

      const canonicalParent = await realpath(currentPath);
      if (!isWithinRoot(this.root, canonicalParent)) return { ok: false, path: relativePath, error: 'Path is outside the workspace.' };
      const isIgnored = await this.isPathIgnored(relativePath, details?.isDirectory() ?? false);
      if (isIgnored && !allowIgnored) return { ok: false, path: relativePath, error: 'This path is ignored by workspace rules.' };
      return {
        ok: true,
        path: relativePath,
        absolutePath,
        exists: missingSegments.length === 0,
        details,
        missingSegments
      };
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        return { ok: false, path: relativePath, error: 'Permission denied.' };
      }
      return { ok: false, path: relativePath, error: 'Target could not be safely resolved.' };
    }
  }
}

export function redactSensitiveValues(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g, '[REDACTED CRYPTOGRAPHIC MATERIAL]')
    .replace(/(\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credentials?)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:live|test)-[A-Za-z0-9]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1[REDACTED]');
}