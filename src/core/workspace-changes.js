import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { isBinaryFileContent } from './workspace-tools.js';
import { WorkspacePolicy } from './workspace-policy.js';

const MAX_CHANGE_FILES = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHANGE_CONTENT_BYTES = 64 * 1024;
const MAX_CHANGE_SET_BYTES = 128 * 1024;
const MAX_DIFF_CHARACTERS = 32_000;
const EDIT_VERBS = /\b(create|add|implement|fix|update|edit|modify|write|change|replace|remove|delete)\b/i;
const EXPLANATION_REQUEST = /^(?:how do i|how can i|how to|what does|what is|why does|where is|explain)\b/i;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function countMatches(content, oldText) {
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(oldText, index)) !== -1) {
    count += 1;
    index += 1;
  }
  return count;
}

function normalizeContent(content) {
  if (typeof content !== 'string' || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) return null;
  return content;
}

function cleanSummary(summary) {
  return String(summary ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
}

function buildDiff(change) {
  const lines = [`--- ${change.action === 'create' ? '/dev/null' : `a/${change.path}`}`, `+++ b/${change.path}`, '@@'];
  if (change.action === 'edit') {
    for (const line of change.oldText.split('\n')) lines.push(`-${line}`);
  }
  for (const line of change.action === 'create' ? change.content.split('\n') : change.newText.split('\n')) {
    lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function fileLabel(change) {
  return change.action === 'create' ? `Create ${change.path}` : `Edit ${change.path}`;
}

function makePreview(proposal) {
  const fileList = proposal.changes.map((change) => {
    const directories = change.parentDirectories?.length
      ? ` (also create ${change.parentDirectories.join(', ')})`
      : '';
    return `- ${fileLabel(change)}${directories}`;
  }).join('\n');
  const protectedWarning = proposal.requiresProtectedConfirmation
    ? '\n\nWARNING: This creates a protected/sensitive file. After approving, Forge will require the exact confirmation `CONFIRM PROTECTED`.'
    : '';
  return [
    `I inspected the workspace and propose: ${proposal.summary || 'Apply the requested code changes.'}`,
    '',
    'Files:',
    fileList,
    '',
    'Diff:',
    proposal.diff,
    '',
    `Apply this complete change set? [y/N/a]${protectedWarning}`
  ].join('\n');
}

function portablePath(path) {
  return path.split(sep).join('/');
}

function diffPathSummary(changes) {
  return changes.map((change) => ({ action: change.action, path: change.path }));
}

export function isChangeRequest(prompt) {
  return EDIT_VERBS.test(prompt) && !EXPLANATION_REQUEST.test(prompt);
}

export function parseChangeSetResponse(response) {
  const openingTag = /<forge-change-set>/i.exec(response);
  const closingTagIndex = response.toLowerCase().lastIndexOf('</forge-change-set>');
  if (!openingTag || closingTagIndex < openingTag.index + openingTag[0].length) return null;
  try {
    const payloadText = response.slice(openingTag.index + openingTag[0].length, closingTagIndex).trim();
    const payload = JSON.parse(payloadText);
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.changes)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function changeSetInstructions() {
  return [
    'The user is requesting a project change. You may only PROPOSE changes; Forge will not write until the user explicitly approves the complete diff.',
    'Use the supplied repository excerpts to propose the smallest correct create/edit set. If context is insufficient, ask for clarification instead of guessing.',
    'Return exactly one <forge-change-set> JSON block and no surrounding prose. Schema: {"summary":"short intent","changes":[{"action":"create","path":"workspace/relative.ext","content":"complete text","createDirectories":false}]} or {"action":"edit","path":"workspace/relative.ext","oldText":"exact existing text","newText":"replacement text"}.',
    'Use only create and edit actions. Never propose deletion, commands, Git operations, absolute paths, or edits to sensitive files. If the user explicitly requests a new sensitive file, a create proposal may be shown, but Forge requires a second protected-file confirmation. For edits oldText must be copied exactly and should occur once. Set createDirectories true only when new parent directories are required and the user asked for that structure.',
    'Do not claim that changes were applied. The CLI will display the complete diff and request approval.'
  ].join('\n');
}

export class WorkspaceWriter {
  constructor(workspaceRoot, { policy, maxFileBytes = MAX_FILE_BYTES } = {}) {
    this.root = resolve(workspaceRoot);
    this.policy = policy ?? new WorkspacePolicy(this.root);
    this.maxFileBytes = Math.min(MAX_FILE_BYTES, Math.max(1, maxFileBytes));
  }

  async inspectTarget(path, { createDirectories = false, allowSensitive = false, allowSensitiveRead = false } = {}) {
    const target = await this.policy.resolveTargetPath(path, {
      allowMissingParents: createDirectories,
      allowSensitive,
      allowIgnored: allowSensitive
    });
    if (!target.ok) return target;
    if (target.exists && this.policy.isSensitivePath(target.path) && !allowSensitiveRead) {
      return { ok: false, path: target.path, error: 'Existing sensitive files cannot be read or changed by AI-generated patches.' };
    }
    if (target.exists && target.details.isDirectory()) {
      return { ok: false, path: target.path, error: 'Target is a directory, not a file.' };
    }
    if (target.exists && !target.details.isFile()) {
      return { ok: false, path: target.path, error: 'Only regular text files can be changed.' };
    }
    if (target.exists && target.details.size > this.maxFileBytes) {
      return { ok: false, path: target.path, error: 'File exceeds the safe change-size limit.' };
    }

    let content = null;
    let mode = 0o666;
    if (target.exists) {
      try {
        const stat = await lstat(target.absolutePath);
        const buffer = await readFile(target.absolutePath);
        if (buffer.length > this.maxFileBytes || isBinaryFileContent(target.path, buffer)) {
          return { ok: false, path: target.path, error: 'Binary or oversized files cannot be changed as source text.' };
        }
        content = buffer.toString('utf8');
        mode = stat.mode & 0o777;
      } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          return { ok: false, path: target.path, error: 'Permission denied.' };
        }
        return { ok: false, path: target.path, error: 'File could not be inspected.' };
      }
    }
    return {
      ...target,
      content,
      hash: content === null ? null : sha256(Buffer.from(content, 'utf8')),
      mode
    };
  }

  async readRaw(path) {
    const target = await this.inspectTarget(path);
    if (!target.ok) return target;
    if (!target.exists) return { ok: false, path: target.path, error: 'File does not exist.' };
    return target;
  }

  refreshPolicy() {
    this.policy = new WorkspacePolicy(this.root);
  }
}

export class WorkspaceChangeManager {
  constructor(workspaceRoot, options = {}) {
    this.writer = new WorkspaceWriter(workspaceRoot, options);
    this.root = this.writer.root;
    this.proposals = new Map();
    this.history = new Map();
  }

  async prepareChangeSet(changeSet) {
    this.writer.refreshPolicy();
    if (!changeSet || !Array.isArray(changeSet.changes) || changeSet.changes.length === 0 || changeSet.changes.length > MAX_CHANGE_FILES) {
      return { ok: false, error: `A change set must contain between 1 and ${MAX_CHANGE_FILES} file operations.` };
    }
    const summary = cleanSummary(changeSet.summary);
    const seenPaths = new Set();
    const changes = [];
    let contentBytes = 0;
    let requiresProtectedConfirmation = false;

    for (const rawChange of changeSet.changes) {
      if (!rawChange || !['create', 'edit'].includes(rawChange.action) || typeof rawChange.path !== 'string') {
        return { ok: false, error: 'Each operation must be a create or edit with a workspace-relative path.' };
      }
      if (rawChange.action === 'edit' && this.writer.policy.isSensitivePath(rawChange.path)) {
        return { ok: false, path: rawChange.path, error: 'Existing sensitive files cannot be read or edited by AI-generated patches.' };
      }
      const targetProbe = await this.writer.policy.resolveTargetPath(rawChange.path, {
        allowMissingParents: rawChange.action === 'create' && rawChange.createDirectories === true,
        allowSensitive: rawChange.action === 'create',
        allowIgnored: rawChange.action === 'create' && this.writer.policy.isSensitivePath(rawChange.path)
      });
      if (!targetProbe.ok) return { ok: false, path: rawChange.path, error: targetProbe.error };
      const path = targetProbe.path;
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (seenPaths.has(key)) return { ok: false, path, error: 'A change set cannot target the same path more than once.' };
      seenPaths.add(key);

      if (rawChange.action === 'create') {
        if (targetProbe.exists) return { ok: false, path, error: 'File already exists; it will not be overwritten by a create operation.' };
        const content = normalizeContent(rawChange.content);
        if (content === null) return { ok: false, path, error: 'New file content must be text without binary control characters.' };
        if (isBinaryFileContent(path, Buffer.from(content, 'utf8'))) {
          return { ok: false, path, error: 'Binary file creation is not supported; provide text source content.' };
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        contentBytes += bytes;
        if (bytes > MAX_CHANGE_CONTENT_BYTES) return { ok: false, path, error: 'New file exceeds the change-size limit.' };
        const protectedFile = this.writer.policy.isSensitivePath(path);
        const target = await this.writer.inspectTarget(path, {
          createDirectories: rawChange.createDirectories === true,
          allowSensitive: protectedFile
        });
        if (!target.ok) return { ok: false, path, error: target.error };
        if (target.missingSegments.length > 1 && rawChange.createDirectories !== true) {
          return { ok: false, path, error: 'Parent directories are missing; createDirectories must be explicitly enabled.' };
        }
        const missingParentCount = Math.max(0, target.missingSegments.length - 1);
        const parentSegments = path.split('/').slice(0, -1);
        const existingParentCount = parentSegments.length - missingParentCount;
        const parentDirectories = [];
        for (const [index, segment] of parentSegments.slice(existingParentCount).entries()) {
          parentDirectories.push(parentSegments.slice(0, existingParentCount + index + 1).join('/'));
        }
        requiresProtectedConfirmation ||= protectedFile;
        changes.push({
          action: 'create',
          path,
          content,
          baseHash: null,
          mode: 0o666,
          createDirectories: rawChange.createDirectories === true,
          parentDirectories,
          sensitive: protectedFile,
          missingSegments: target.missingSegments
        });
        continue;
      }

      const target = await this.writer.readRaw(path);
      if (!target.ok) return { ok: false, path, error: target.error };
      const oldText = normalizeContent(rawChange.oldText);
      const newText = normalizeContent(rawChange.newText);
      if (typeof oldText !== 'string' || oldText.length === 0 || typeof newText !== 'string') {
        return { ok: false, path, error: 'Edits require non-empty exact oldText and string newText.' };
      }
      const matches = countMatches(target.content, oldText);
      if (matches === 0) return { ok: false, path, error: 'The requested old text was not found; no changes were made.' };
      if (matches > 1) return { ok: false, path, error: `The requested old text occurs ${matches} times and needs clarification.` };
      const newContent = target.content.replace(oldText, newText);
      if (!newContent.trim()) return { ok: false, path, error: 'An edit cannot empty a file; file deletion is not supported.' };
      const bytes = Buffer.byteLength(newContent, 'utf8');
      contentBytes += Buffer.byteLength(oldText, 'utf8') + Buffer.byteLength(newText, 'utf8');
      if (bytes > MAX_CHANGE_CONTENT_BYTES) return { ok: false, path, error: 'Edited file exceeds the change-size limit.' };
      changes.push({
        action: 'edit',
        path,
        oldText,
        newText,
        content: newContent,
        originalContent: target.content,
        baseHash: target.hash,
        mode: target.mode,
        sensitive: false
      });
    }

    if (contentBytes > MAX_CHANGE_SET_BYTES) return { ok: false, error: 'Change set exceeds the total content limit.' };
    const diff = changes.map(buildDiff).join('\n\n');
    if (diff.length > MAX_DIFF_CHARACTERS) return { ok: false, error: 'Diff is too large to preview safely; request smaller changes.' };

    const id = randomUUID();
    const proposal = {
      id,
      summary: summary || 'Apply the requested project changes.',
      changes,
      requiresProtectedConfirmation,
      diff
    };
    proposal.preview = makePreview(proposal);
    this.proposals.set(id, proposal);
    return {
      ok: true,
      proposal: {
        id,
        summary: proposal.summary,
        changes: diffPathSummary(changes),
        requiresProtectedConfirmation,
        diff,
        preview: proposal.preview
      }
    };
  }

  async createFile(path, content, options = {}) {
    return this.prepareToolChange({
      summary: options.summary ?? `Create ${path}`,
      changes: [{ action: 'create', path, content, createDirectories: options.createDirectories === true }]
    }, options);
  }

  async writeFile(path, content, options = {}) {
    const targetInfo = await this.writer.policy.resolveTargetPath(path, {
      allowMissingParents: options.createDirectories === true
    });
    if (!targetInfo.ok) return targetInfo;
    if (targetInfo.exists && (options.overwrite !== true || !options.expectedHash)) {
      return { ok: false, path: targetInfo.path, error: 'Existing files require overwrite:true and an expectedHash.' };
    }
    if (!targetInfo.exists) return this.createFile(path, content, options);
    const target = await this.writer.inspectTarget(path);
    if (!target.ok) return target;
    if (target.hash !== options.expectedHash) {
      return { ok: false, path: target.path, error: 'File changed since it was inspected; regenerate the proposal.' };
    }
    return this.editFile(path, target.content, content, options);
  }

  async editFile(path, oldText, newText, options = {}) {
    return this.prepareToolChange({
      summary: options.summary ?? `Edit ${path}`,
      changes: [{ action: 'edit', path, oldText, newText }]
    }, options);
  }

  async prepareToolChange(changeSet, options) {
    const prepared = await this.prepareChangeSet(changeSet);
    if (!prepared.ok || options.approved !== true) return prepared;
    return this.applyChangeSet(prepared.proposal.id, {
      approved: true,
      protectedConfirmation: options.protectedConfirmation === true
    });
  }

  async cancelChangeSet(id) {
    const existed = this.proposals.delete(id);
    return { ok: existed, cancelled: existed };
  }

  async applyChangeSet(id, { approved = false, protectedConfirmation = false } = {}) {
    const proposal = this.proposals.get(id);
    if (!proposal) return { ok: false, error: 'Proposal is no longer pending.' };
    if (approved !== true) return { ok: false, error: 'Explicit approval is required before writing files.' };
    if (proposal.requiresProtectedConfirmation && protectedConfirmation !== true) {
      return { ok: false, requiresProtectedConfirmation: true, error: 'Type CONFIRM PROTECTED after approval to create a protected file.' };
    }

    this.writer.refreshPolicy();
    const preflight = await this.preflight(proposal.changes);
    if (!preflight.ok) return preflight;
    const createdDirectories = [];
    const staged = [];
    const applied = [];
    const operationId = id;
    try {
      await this.createRequiredDirectories(proposal.changes, createdDirectories);
      this.writer.refreshPolicy();
      const secondCheck = await this.preflight(proposal.changes);
      if (!secondCheck.ok) throw new Error(secondCheck.error);

      for (let index = 0; index < proposal.changes.length; index += 1) {
        const change = proposal.changes[index];
        const absolutePath = resolve(this.root, ...change.path.split('/'));
        const stagePath = resolve(dirname(absolutePath), `.forge-secret-${operationId}-${index}-${randomUUID()}.stage`);
        await this.writeStage(stagePath, change.content, change.mode);
        staged.push({ change, absolutePath, stagePath });
      }

      for (const item of staged) {
        const { change, absolutePath, stagePath } = item;
        if (change.action === 'create') {
          await this.installStage(stagePath, absolutePath);
          applied.push({ action: 'create', absolutePath, installed: true });
          continue;
        }

        const backupPath = resolve(dirname(absolutePath), `.forge-secret-${operationId}-${randomUUID()}.backup`);
        await rename(absolutePath, backupPath);
        const record = { action: 'edit', absolutePath, backupPath, installed: false };
        applied.push(record);
        const backedUp = await lstat(backupPath);
        if (!backedUp.isFile() || backedUp.isSymbolicLink() || sha256(await readFile(backupPath)) !== change.baseHash) {
          throw new Error(`File changed during apply: ${change.path}`);
        }
        await this.installStage(stagePath, absolutePath);
        record.installed = true;
      }

      const history = proposal.changes.map((change) => ({
        action: change.action,
        path: change.path,
        beforeContent: change.action === 'edit' ? change.originalContent : null,
        beforeHash: change.baseHash,
        afterHash: sha256(Buffer.from(change.content, 'utf8')),
        mode: change.mode,
        sensitive: change.sensitive
      }));
      this.history.set(operationId, { changes: history, createdDirectories });
      this.proposals.delete(id);
      for (const record of applied) {
        if (record.backupPath) await unlink(record.backupPath).catch(() => {});
      }
      return { ok: true, operationId, changed: diffPathSummary(proposal.changes) };
    } catch (error) {
      const rollbackErrors = await this.rollbackApplied(applied);
      await this.removeCreatedDirectories(createdDirectories);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Change application failed.',
        rollbackComplete: rollbackErrors.length === 0,
        rollbackErrors
      };
    } finally {
      for (const item of staged) await unlink(item.stagePath).catch(() => {});
    }
  }

  async rollback(operationId) {
    const operation = this.history.get(operationId);
    if (!operation) return { ok: false, error: 'Rollback snapshot is not available in this session.' };
    const currentFiles = [];
    for (const change of operation.changes) {
      const target = await this.writer.inspectTarget(change.path, {
        allowSensitive: change.sensitive,
        allowSensitiveRead: change.sensitive
      });
      if (!target.ok || !target.exists || sha256(Buffer.from(target.content, 'utf8')) !== change.afterHash) {
        return { ok: false, error: `File changed since the operation: ${change.path}. Rollback was not applied.` };
      }
      currentFiles.push({ change, absolutePath: target.absolutePath });
    }

    const staged = [];
    const moved = [];
    try {
      for (let index = 0; index < currentFiles.length; index += 1) {
        const { change, absolutePath } = currentFiles[index];
        if (change.action === 'create') continue;
        const stagePath = resolve(dirname(absolutePath), `.forge-secret-rollback-${operationId}-${index}-${randomUUID()}.stage`);
        await this.writeStage(stagePath, change.beforeContent, change.mode);
        staged.push({ change, absolutePath, stagePath });
      }

      for (const { change, absolutePath } of currentFiles) {
        const backupPath = resolve(dirname(absolutePath), `.forge-secret-rollback-${operationId}-${randomUUID()}.backup`);
        await rename(absolutePath, backupPath);
        const record = { change, absolutePath, backupPath, installed: false };
        moved.push(record);
        if (sha256(await readFile(backupPath)) !== change.afterHash) throw new Error(`File changed during rollback: ${change.path}`);
        if (change.action === 'edit') {
          const stage = staged.find((entry) => entry.change.path === change.path);
          await this.installStage(stage.stagePath, absolutePath);
          record.installed = true;
        }
      }

      for (const record of moved) await unlink(record.backupPath).catch(() => {});
      await this.removeCreatedDirectories(operation.createdDirectories);
      this.history.delete(operationId);
      return { ok: true, operationId, restored: operation.changes.map((change) => change.path) };
    } catch (error) {
      const rollbackErrors = [];
      for (const record of moved.reverse()) {
        try {
          if (record.installed) await unlink(record.absolutePath).catch(() => {});
          await rename(record.backupPath, record.absolutePath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : 'Rollback restoration failed.');
        }
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Rollback failed.',
        rollbackComplete: rollbackErrors.length === 0,
        rollbackErrors
      };
    } finally {
      for (const item of staged) await unlink(item.stagePath).catch(() => {});
    }
  }

  async installStage(stagePath, targetPath) {
    await link(stagePath, targetPath);
  }

  async preflight(changes) {
    for (const change of changes) {
      if (change.action === 'create') {
        const target = await this.writer.policy.resolveTargetPath(change.path, {
          allowMissingParents: change.createDirectories,
          allowSensitive: change.sensitive,
          allowIgnored: change.sensitive
        });
        if (!target.ok) return { ok: false, path: change.path, error: target.error };
        if (target.exists) return { ok: false, path: change.path, error: 'Target appeared after the proposal; regenerate the change set.' };
        if (target.missingSegments.length > 1 && !change.createDirectories) {
          return { ok: false, path: change.path, error: 'Parent directories changed after the proposal; regenerate it.' };
        }
        continue;
      }
      const target = await this.writer.inspectTarget(change.path, {
        createDirectories: change.createDirectories,
        allowSensitive: change.sensitive
      });
      if (!target.ok) return { ok: false, path: change.path, error: target.error };
      if (!target.exists || target.hash !== change.baseHash) {
        return { ok: false, path: change.path, error: 'File changed after the proposal; regenerate the change set.' };
      }
      if (countMatches(target.content, change.oldText) !== 1 || target.content.replace(change.oldText, change.newText) !== change.content) {
        return { ok: false, path: change.path, error: 'Patch context changed or became ambiguous; regenerate the change set.' };
      }
    }
    return { ok: true };
  }

  async createRequiredDirectories(changes, createdDirectories) {
    const planned = new Set();
    for (const change of changes) {
      if (change.action !== 'create' || !change.createDirectories) continue;
      const parentSegments = change.path.split('/').slice(0, -1);
      let current = this.root;
      for (const segment of parentSegments) {
        current = resolve(current, segment);
        if (planned.has(current)) continue;
        try {
          const details = await lstat(current);
          if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Unsafe parent directory: ${change.path}`);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          await mkdir(current);
          createdDirectories.push(current);
        }
        planned.add(current);
      }
    }
  }

  async writeStage(path, content, mode) {
    const handle = await open(path, 'wx', mode ?? 0o666);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rollbackApplied(applied) {
    const errors = [];
    for (const record of applied.reverse()) {
      try {
        if (record.action === 'create') {
          await unlink(record.absolutePath);
        } else {
          if (record.installed) await unlink(record.absolutePath).catch(() => {});
          await rename(record.backupPath, record.absolutePath);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Could not restore a file.');
      }
    }
    return errors;
  }

  async removeCreatedDirectories(directories) {
    for (const directory of [...directories].reverse()) {
      await rmdir(directory).catch(() => {});
    }
  }
}