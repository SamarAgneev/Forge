import { constants } from 'node:fs';
import { opendir, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { redactSensitiveValues, WorkspacePolicy } from './workspace-policy.js';

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024,
  maxFileCharacters: 20_000,
  maxSearchFileBytes: 64 * 1024,
  maxSearchBytes: 2 * 1024 * 1024,
  maxSearchFiles: 250,
  maxSearchEntries: 1200,
  maxListEntries: 150,
  maxSearchResults: 40,
  maxSearchDepth: 8,
  maxListDepth: 3,
  maxLineRange: 300
});
const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.aac', '.apk', '.app', '.avi', '.bin', '.bmp', '.class', '.db', '.dll', '.docx', '.dmg', '.dylib', '.exe', '.flac',
  '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.m4a', '.mdb', '.mkv', '.mov', '.mp3', '.mp4',
  '.o', '.otf', '.pdf', '.png', '.pptx', '.psd', '.pyc', '.rar', '.so', '.sqlite', '.sqlite3', '.swf', '.tar', '.ttf', '.wasm',
  '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
]);
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js', '.jsx', '.mjs', '.php',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'
]);

function withinRoot(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizeRelativePath(path) {
  return path.split(sep).join('/');
}

function normalizeExtensions(extensions) {
  if (!extensions) return null;
  const values = Array.isArray(extensions) ? extensions : [extensions];
  return new Set(values.map((extension) => {
    const normalized = String(extension).toLowerCase();
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
  }));
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
}

function isProbablyBinary(buffer) {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  const signature = buffer.subarray(0, 8);
  if (signature.subarray(0, 2).toString() === 'MZ'
    || signature.subarray(0, 4).toString('hex') === '7f454c46'
    || signature.subarray(0, 4).toString() === 'PK\x03\x04'
    || signature.subarray(0, 4).toString() === '%PDF'
    || signature.subarray(0, 4).toString() === 'OggS'
    || signature.subarray(0, 3).toString() === 'ID3'
    || signature.subarray(0, 4).toString() === 'GIF8'
    || signature.subarray(0, 2).toString() === 'BM'
    || signature.subarray(0, 4).toString('hex') === '89504e47'
    || signature.subarray(0, 4).toString() === 'RIFF'
    || buffer.subarray(0, 16).toString().startsWith('SQLite format 3')) return true;
  if (signature.subarray(4, 8).toString() === 'ftyp') return true;
  let controlBytes = 0;
  for (const byte of buffer) {
    if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 0) controlBytes += 1;
  }
  return controlBytes / buffer.length > 0.03;
}

export function isBinaryFileContent(path, buffer) {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase()) || isProbablyBinary(buffer);
}

async function readLimitedBuffer(filePath, maxBytes) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return { buffer: buffer.subarray(0, bytesRead), tooLarge: bytesRead > maxBytes };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function resultError(path, error, extra = {}) {
  return { ok: false, ...(path ? { path } : {}), error, ...extra };
}

function safeSnippet(line, matchTerms, caseSensitive, maxLength = 240) {
  let index = 0;
  const comparableLine = caseSensitive ? line : line.toLowerCase();
  for (const term of matchTerms) {
    const comparableTerm = caseSensitive ? term : term.toLowerCase();
    const matchIndex = comparableLine.indexOf(comparableTerm);
    if (matchIndex >= 0) {
      index = matchIndex;
      break;
    }
  }
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const snippet = line.slice(start, start + maxLength).trim();
  return `${start > 0 ? '...' : ''}${snippet}${start + maxLength < line.length ? '...' : ''}`;
}

function textMatches(line, query, matchTerms, caseSensitive) {
  const comparableLine = caseSensitive ? line : line.toLowerCase();
  const terms = matchTerms?.length ? matchTerms : [query];
  const hits = terms.filter((term) => comparableLine.includes(caseSensitive ? term : term.toLowerCase()));
  return hits.length ? [...new Set(hits)].length : 0;
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export class WorkspaceTools {
  constructor(root, limits = {}) {
    this.root = resolve(root);
    this.limits = {
      maxFileBytes: clamp(limits.maxFileBytes, 1, 1024 * 1024, DEFAULT_LIMITS.maxFileBytes),
      maxFileCharacters: clamp(limits.maxFileCharacters, 1, 100_000, DEFAULT_LIMITS.maxFileCharacters),
      maxSearchFileBytes: clamp(limits.maxSearchFileBytes, 1, 256 * 1024, DEFAULT_LIMITS.maxSearchFileBytes),
      maxSearchBytes: clamp(limits.maxSearchBytes, 1, 16 * 1024 * 1024, DEFAULT_LIMITS.maxSearchBytes),
      maxSearchFiles: clamp(limits.maxSearchFiles, 1, 1000, DEFAULT_LIMITS.maxSearchFiles),
      maxSearchEntries: clamp(limits.maxSearchEntries, 1, 5000, DEFAULT_LIMITS.maxSearchEntries),
      maxListEntries: clamp(limits.maxListEntries, 1, 1000, DEFAULT_LIMITS.maxListEntries),
      maxSearchResults: clamp(limits.maxSearchResults, 1, 200, DEFAULT_LIMITS.maxSearchResults),
      maxSearchDepth: clamp(limits.maxSearchDepth, 0, 10, DEFAULT_LIMITS.maxSearchDepth),
      maxListDepth: clamp(limits.maxListDepth, 0, 6, DEFAULT_LIMITS.maxListDepth),
      maxLineRange: clamp(limits.maxLineRange, 1, 1000, DEFAULT_LIMITS.maxLineRange)
    };
    this.policy = new WorkspacePolicy(this.root);
  }

  async resolvePath(path) {
    if (typeof path !== 'string' || /[\u0000-\u001f\u007f]/.test(path)) return resultError(null, 'Invalid workspace-relative path.');
    const requested = path.trim();
    if (!requested || isAbsolute(requested) || win32.isAbsolute(requested) || /^[a-z]:/i.test(requested)) {
      return resultError(null, 'Use a path relative to the workspace.');
    }

    const segments = requested.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.');
    if (segments.includes('..')) return resultError(null, 'Path traversal is not allowed.');
    if (segments.some((segment) => segment.includes(':'))) return resultError(null, 'Invalid workspace-relative path.');
    const relativePath = segments.join('/');
    if (this.policy.isProtectedPath(relativePath)) return resultError(relativePath, 'This path is protected and cannot be inspected.');

    const resolved = await this.policy.resolvePath(relativePath || '.');
    if (!resolved.ok) return resultError(relativePath, resolved.error);
    const canonical = await realpath(resolved.absolutePath).catch(() => resolved.absolutePath);
    if (!withinRoot(this.root, canonical)) return resultError(relativePath, 'Path is outside the workspace.');
    return { ...resolved, path: relativePath || '.', relativePath, absolutePath: canonical };
  }

  async readFile(path, options = {}) {
    const resolved = await this.resolvePath(path);
    if (!resolved.ok) return resolved;
    if (resolved.details.isDirectory()) return resultError(resolved.path, 'Path is a directory, not a file.');
    if (!resolved.details.isFile()) return resultError(resolved.path, 'Only regular text files can be read.');
    if (await this.policy.isPathIgnored(resolved.relativePath, false)) {
      return resultError(resolved.path, 'This file is ignored by workspace rules.');
    }

    const maxFileBytes = clamp(options.maxFileBytes, 1, this.limits.maxFileBytes, this.limits.maxFileBytes);
    if (resolved.details.size > maxFileBytes) {
      return resultError(resolved.path, 'File is too large to read completely.', {
        sizeBytes: resolved.details.size,
        maxFileBytes,
        tooLarge: true
      });
    }
    if (BINARY_EXTENSIONS.has(extname(resolved.path).toLowerCase())) {
      return resultError(resolved.path, 'Binary files cannot be inspected as source text.', {
        sizeBytes: resolved.details.size,
        binary: true
      });
    }

    let contents;
    try {
      contents = await readLimitedBuffer(resolved.absolutePath, maxFileBytes);
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return resultError(resolved.path, 'Permission denied.');
      return resultError(resolved.path, 'File could not be read.');
    }
    if (contents.tooLarge) {
      return resultError(resolved.path, 'File is too large to read completely.', {
        sizeBytes: resolved.details.size,
        maxFileBytes,
        tooLarge: true
      });
    }
    if (isProbablyBinary(contents.buffer)) {
      return resultError(resolved.path, 'Binary files cannot be inspected as source text.', {
        sizeBytes: resolved.details.size,
        binary: true
      });
    }

    let text = contents.buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    const rangeRequested = options.startLine !== undefined || options.endLine !== undefined;
    const startLine = rangeRequested ? clamp(options.startLine, 1, Math.max(1, lines.length), 1) : 1;
    const endLine = rangeRequested
      ? clamp(options.endLine, startLine, Math.max(startLine, lines.length), lines.length)
      : lines.length;
    if (rangeRequested && endLine - startLine + 1 > this.limits.maxLineRange) {
      return resultError(resolved.path, `Requested line range exceeds the ${this.limits.maxLineRange}-line limit.`, {
        sizeBytes: resolved.details.size,
        maxLineRange: this.limits.maxLineRange
      });
    }
    text = lines.slice(startLine - 1, endLine).join('\n');
    const maxCharacters = clamp(options.maxCharacters, 1, this.limits.maxFileCharacters, this.limits.maxFileCharacters);
    const truncated = text.length > maxCharacters;
    if (truncated) text = text.slice(0, maxCharacters);
    return {
      ok: true,
      path: resolved.path,
      sizeBytes: resolved.details.size,
      startLine,
      endLine: Math.min(endLine, lines.length),
      content: redactSensitiveValues(text),
      truncated,
      binary: false
    };
  }

  async listDirectory(directory = '.', options = {}) {
    const resolved = await this.resolvePath(directory);
    if (!resolved.ok) return { ...resolved, entries: [] };
    if (!resolved.details.isDirectory()) return { ...resultError(resolved.path, 'Path is not a directory.'), entries: [] };
    if (resolved.relativePath && await this.policy.isPathIgnored(resolved.relativePath, true)) {
      return { ...resultError(resolved.path, 'This directory is ignored by workspace rules.'), entries: [] };
    }

    const recursive = options.recursive === true;
    const maxDirectoryDepth = recursive
      ? Math.max(this.limits.maxListDepth, this.limits.maxSearchDepth)
      : this.limits.maxListDepth;
    const maxDepth = clamp(options.maxDepth, 0, maxDirectoryDepth, recursive ? this.limits.maxListDepth : 0);
    const maxEntries = clamp(options.maxEntries, 1, 5000, this.limits.maxListEntries);
    const extensionFilter = normalizeExtensions(options.extensions);
    const filePattern = options.filePattern ? globToRegExp(options.filePattern) : null;
    const entries = [];
    let inspectedEntries = 0;
    let truncated = false;

    const visit = async (absoluteDirectory, relativeDirectory, depth) => {
      let handle;
      const children = [];
      try {
        handle = await opendir(absoluteDirectory);
        for await (const entry of handle) {
          if (inspectedEntries >= maxEntries * 4) {
            truncated = true;
            break;
          }
          inspectedEntries += 1;
          children.push(entry);
        }
      } catch {
        return;
      }
      children.sort((left, right) => left.name.localeCompare(right.name));

      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (child.isSymbolicLink() || this.policy.isSensitiveName(child.name)) continue;
        const isDirectory = child.isDirectory();
        if (isDirectory && this.policy.isExcludedDirectoryName(child.name)) continue;
        const childRelative = relativeDirectory ? `${relativeDirectory}${sep}${child.name}` : child.name;
        if (await this.policy.isPathIgnored(childRelative, isDirectory)) continue;
        const extension = extname(child.name).toLowerCase();
        if (!isDirectory && extensionFilter && !extensionFilter.has(extension)) continue;
        if (!isDirectory && filePattern && !filePattern.test(child.name)) continue;

        entries.push({
          path: normalizeRelativePath(childRelative),
          name: child.name.replace(/[\u0000-\u001f\u007f]/g, '?'),
          type: isDirectory ? 'directory' : 'file'
        });
        if (recursive && isDirectory && depth < maxDepth) {
          await visit(resolve(absoluteDirectory, child.name), childRelative, depth + 1);
        } else if (recursive && isDirectory && depth >= maxDepth) {
          truncated = true;
        }
      }
    };

    await visit(resolved.absolutePath, resolved.relativePath, 0);
    return { ok: true, path: resolved.path, entries, inspectedEntries, truncated };
  }

  async searchCode(query, options = {}) {
    const searchText = typeof query === 'string' ? query.trim() : '';
    const matchTerms = Array.isArray(options.matchTerms)
      ? options.matchTerms.map((term) => String(term).trim()).filter(Boolean).slice(0, 12)
      : null;
    if (!searchText && !matchTerms?.length) return resultError(null, 'Enter text to search for.');
    if (searchText.length > 500) return resultError(null, 'Search query is too long.');

    const directory = options.directory ?? '.';
    const listed = await this.listDirectory(directory, {
      recursive: true,
      maxDepth: clamp(options.maxDepth, 0, this.limits.maxSearchDepth, this.limits.maxSearchDepth),
      maxEntries: clamp(options.maxEntries, 1, this.limits.maxSearchEntries, this.limits.maxSearchEntries)
    });
    if (!listed.ok) return { ...listed, query: searchText, results: [] };

    const extensions = normalizeExtensions(options.extensions);
    const filePattern = options.filePattern ? globToRegExp(options.filePattern) : null;
    const caseSensitive = options.caseSensitive === true;
    const maxResults = clamp(options.maxResults, 1, this.limits.maxSearchResults, this.limits.maxSearchResults);
    const maxFiles = clamp(options.maxFiles, 1, this.limits.maxSearchFiles, this.limits.maxSearchFiles);
    const maxBytes = clamp(options.maxBytes, 1, this.limits.maxSearchBytes, this.limits.maxSearchBytes);
    const maxFileBytes = clamp(options.maxFileBytes, 1, this.limits.maxSearchFileBytes, this.limits.maxSearchFileBytes);
    const results = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let skippedLargeFiles = 0;
    let truncated = listed.truncated;

    for (const entry of listed.entries) {
      if (entry.type !== 'file') continue;
      if (filesScanned >= maxFiles || bytesScanned >= maxBytes) {
        truncated = true;
        break;
      }
      const extension = extname(entry.path).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      if (extensions && !extensions.has(extension)) continue;
      if (filePattern && !filePattern.test(basename(entry.path))) continue;

      filesScanned += 1;
      const remainingBytes = maxBytes - bytesScanned;
      const fileLimit = Math.min(maxFileBytes, remainingBytes);
      const content = await this.readFile(entry.path, { maxFileBytes: fileLimit, maxCharacters: fileLimit });
      if (!content.ok) {
        if (content.tooLarge) skippedLargeFiles += 1;
        continue;
      }
      bytesScanned += content.sizeBytes;
      const lines = content.content.split(/\r?\n/);
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const score = textMatches(lines[index], searchText, matchTerms, caseSensitive);
        if (!score) continue;
        const terms = matchTerms?.length ? matchTerms : [searchText];
        results.push({
          path: entry.path,
          line: index + 1,
          snippet: safeSnippet(lines[index], terms, caseSensitive),
          score
        });
        fileMatches += 1;
        if (fileMatches >= 4) break;
      }
      if (content.truncated) truncated = true;
    }

    results.sort((left, right) => right.score - left.score
      || Number(SOURCE_EXTENSIONS.has(extname(right.path).toLowerCase())) - Number(SOURCE_EXTENSIONS.has(extname(left.path).toLowerCase()))
      || left.path.localeCompare(right.path)
      || left.line - right.line);
    const limitedResults = results.slice(0, maxResults).map(({ score, ...result }) => result);
    return {
      ok: true,
      query: searchText || matchTerms.join(' '),
      results: limitedResults,
      filesScanned,
      bytesScanned,
      skippedLargeFiles,
      truncated: truncated || results.length > maxResults
    };
  }
}

export async function createWorkspaceTools(workspaceRoot, options = {}) {
  const root = await realpath(resolve(workspaceRoot));
  return new WorkspaceTools(root, options.limits);
}