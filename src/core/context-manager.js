import { createProjectContext } from './project-inspector.js';
import { buildRepositoryContext } from './repository-context.js';

const DEFAULT_MAX_CHARACTERS = 12_000;
const DEFAULT_MAX_MESSAGES = 32;
const REPOSITORY_TOPIC = /\b(auth(?:entication|enticate)?|login|session|database|db|model|schema|payment|billing|function|class|method|implementation|implement(?:ed|ation)?|code|file|files|reference|references|endpoint|api|source|project|repository|repo|workspace|path|paths|traversal)\b/i;
const STOP_WORDS = new Set([
  'about', 'all', 'and', 'are', 'does', 'file', 'files', 'for', 'forge', 'from', 'handle', 'handles', 'how', 'in', 'is', 'it',
  'code', 'explain', 'find', 'me', 'my', 'of', 'on', 'path', 'paths', 'prevent', 'prevents', 'project', 'repo', 'repository',
  'source', 'the', 'this', 'to', 'use', 'uses', 'using', 'what', 'where', 'which', 'work', 'works', 'workspace'
]);
const TERM_FAMILIES = new Map([
  ['project', ['readme', 'description', 'main']],
  ['repository', ['readme', 'description', 'main']],
  ['repo', ['readme', 'description', 'main']],
  ['auth', ['auth', 'authentication', 'authenticate', 'login', 'session']],
  ['authentication', ['auth', 'authentication', 'authenticate', 'login', 'session']],
  ['authenticate', ['auth', 'authentication', 'authenticate', 'login', 'session']],
  ['login', ['auth', 'authentication', 'login', 'session']],
  ['database', ['database', 'db', 'schema', 'query']],
  ['db', ['database', 'db', 'schema', 'query']],
  ['payment', ['payment', 'payments', 'billing', 'charge']],
  ['payments', ['payment', 'payments', 'billing', 'charge']],
  ['billing', ['payment', 'payments', 'billing', 'charge']]
]);

function estimateTokenCount(text) {
  return Math.max(1, Math.ceil((String(text ?? '').length || 1) / 4));
}

function normalizeRelativePath(path) {
  return String(path ?? '').replace(/\\/g, '/');
}

function searchTermsForPrompt(prompt) {
  const terms = new Set();
  const words = String(prompt ?? '').match(/[A-Za-z_$][\w$-]*/g) ?? [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || lower.length < 3) continue;
    for (const term of TERM_FAMILIES.get(lower) ?? [word]) {
      terms.add(term);
    }
    if (terms.size >= 12) break;
  }
  return [...terms].slice(0, 12);
}

export class ContextBudget {
  constructor({ maxCharacters = DEFAULT_MAX_CHARACTERS, maxTokens = null, maxMessages = DEFAULT_MAX_MESSAGES } = {}) {
    this.maxCharacters = Number(maxCharacters) || DEFAULT_MAX_CHARACTERS;
    this.maxTokens = Number(maxTokens) || Math.ceil(this.maxCharacters / 4);
    this.maxMessages = Number(maxMessages) || DEFAULT_MAX_MESSAGES;
    this.usage = {
      characters: 0,
      estimatedTokens: 0,
      messages: 0,
      files: 0,
      toolOutputs: 0
    };
  }

  addText(text, { kind = 'content' } = {}) {
    const content = String(text ?? '');
    this.usage.characters += content.length;
    this.usage.estimatedTokens += estimateTokenCount(content);
    if (kind === 'message') this.usage.messages += 1;
    if (kind === 'file') this.usage.files += 1;
    if (kind === 'tool') this.usage.toolOutputs += 1;
    return this.usage;
  }

  addMessage(message) {
    if (!message || typeof message !== 'object') return this.usage;
    this.addText(message.content ?? '', { kind: 'message' });
    return this.usage;
  }

  isOverflowing() {
    return this.usage.characters > this.maxCharacters
      || this.usage.estimatedTokens > this.maxTokens
      || this.usage.messages > this.maxMessages;
  }

  priorityOrder(items) {
    const priorities = new Map([
      ['current request', 0],
      ['current task state', 1],
      ['current errors', 2],
      ['relevant changed files', 3],
      ['directly relevant source', 4],
      ['relevant tests', 5],
      ['project configuration', 6],
      ['recent tool results', 7],
      ['older conversation history', 8]
    ]);
    return [...items].sort((left, right) => (priorities.get(left) ?? 99) - (priorities.get(right) ?? 99));
  }
}

export class ContextManager {
  constructor({ maxCharacters = DEFAULT_MAX_CHARACTERS, maxTokens = null, maxMessages = DEFAULT_MAX_MESSAGES, debug = false } = {}) {
    this.budget = new ContextBudget({ maxCharacters, maxTokens, maxMessages });
    this.maxCharacters = this.budget.maxCharacters;
    this.maxTokens = this.budget.maxTokens;
    this.maxMessages = this.budget.maxMessages;
    this.debug = Boolean(debug);
    this.cache = new Map();
    this.debugState = { selected: [], excluded: [], estimatedTokens: 0 };
  }

  estimateTokens(text) {
    return estimateTokenCount(text);
  }

  filterSensitiveContent(content) {
    return String(content ?? '')
      .replace(/(^|\s)(?:API[_-]?KEY|OPENAI_API_KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)(\s*[:=]\s*)([^\n\r]+)/gim, '$1$2[REDACTED]')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN [REDACTED] PRIVATE KEY-----\n...\n-----END [REDACTED] PRIVATE KEY-----')
      .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*["'][^"']+["']/gim, '$1=[REDACTED]')
      .replace(/(aws_secret_access_key|access_key_id|client_secret)\s*[:=]\s*[^\s,\]]+/gim, '$1=[REDACTED]');
  }

  async readCachedFile(readFn, path, options = {}) {
    const key = `${String(path)}::${JSON.stringify(options)}`;
    const cached = this.cache.get(key);
    if (cached) return cached.value;
    const value = await readFn(path, options);
    this.cache.set(key, { value, path: String(path), ts: Date.now() });
    return value;
  }

  invalidateCache(path) {
    const normalized = String(path ?? '');
    for (const [key, entry] of this.cache.entries()) {
      if (entry.path === normalized || key.startsWith(`${normalized}::`)) this.cache.delete(key);
    }
    return true;
  }

  priorityOrder(items) {
    return this.budget.priorityOrder(items);
  }

  rankFilesForPrompt(searchResults, prompt) {
    const promptText = String(prompt ?? '').toLowerCase();
    const terms = new Set([
      ...searchTermsForPrompt(promptText),
      ...(promptText.match(/[a-z_][\w-]{2,}/g) ?? [])
    ]);
    const relevantPhrases = /auth|login|session|token|user|permission|verify|project|repository|workspace|path/i;

    return [...(Array.isArray(searchResults) ? searchResults : [])]
      .map((result) => {
        const path = normalizeRelativePath(result?.path ?? '');
        const pointer = path.toLowerCase();
        let score = Number(result?.score ?? 0) || 1;

        for (const term of terms) {
          const lowerTerm = String(term).toLowerCase();
          if (pointer.includes(lowerTerm) || path.includes(term)) score += 4;
        }
        if (/\b(src|lib|app|server|core|routes|api)\b/.test(pointer)) score += 2;
        if (/test|spec/i.test(path)) score += 2;
        if (relevantPhrases.test(pointer)) score += 3;
        if (/readme|config|package|manifest|\.env|\.gitignore/i.test(pointer)) score += 1;
        if (pointer.includes('analytics') && !relevantPhrases.test(promptText)) score -= 100;
        return { ...result, path, score };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  }

  chunkCode(content) {
    const source = String(content ?? '');
    if (!source.trim()) return [''];
    const lines = source.split(/\r?\n/);

    const blockEntries = [];
    let currentStart = null;
    let depth = 0;
    let currentLine = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      const isDeclaration = /^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?class\s+\w+|^(?:export\s+)?interface\s+\w+|^(?:export\s+)?(?:const|let|var)\s+\w+\s*=/.test(trimmed);
      if (isDeclaration && currentStart === null) {
        currentStart = index;
        currentLine = trimmed;
        depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        continue;
      }

      if (currentStart !== null) {
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (depth <= 0) {
          blockEntries.push(lines.slice(currentStart, index + 1).join('\n').trim());
          currentStart = null;
          depth = 0;
        }
      }
    }
    if (currentStart !== null) {
      blockEntries.push(lines.slice(currentStart).join('\n').trim());
    }

    if (blockEntries.length > 0) {
      return [...new Set(blockEntries.filter((block) => block && block.length > 0))];
    }

    const maxChunkSize = 220;
    const chunks = [];
    for (let index = 0; index < lines.length; index += maxChunkSize) {
      const chunk = lines.slice(index, index + maxChunkSize).join('\n').trim();
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  compressConversation(messages) {
    const log = Array.isArray(messages) ? messages.filter((message) => message && typeof message === 'object') : [];
    if (log.length <= 6) return log.map((message) => `${message.role}: ${message.content}`).join('\n');

    const summary = [];
    const recent = log.slice(-4);
    const older = log.slice(0, -4);
    const requirements = older.filter((message) => message.role === 'user').map((message) => message.content).slice(0, 4);
    const decisions = older.filter((message) => message.role === 'assistant').map((message) => message.content).slice(0, 4);
    if (requirements.length) summary.push(`User goal: ${requirements.join(' | ')}`);
    if (decisions.length) summary.push(`Decisions: ${decisions.join(' | ')}`);
    const unresolved = [...older, ...recent].filter((message) => /blocked|failing|missing|error|verify|pending|warning/i.test(String(message.content ?? ''))).slice(0, 4);
    if (unresolved.length) summary.push(`Unresolved issues: ${unresolved.map((message) => message.content).join(' | ')}`);
    if (recent.length) summary.push(`Recent activity: ${recent.map((message) => `${message.role}: ${message.content}`).join(' | ')}`);
    return summary.join('\n');
  }

  async buildRepositoryMap(workspaceTools) {
    if (!workspaceTools || typeof workspaceTools.listDirectory !== 'function') return null;
    const listing = await workspaceTools.listDirectory('.', { recursive: true, maxDepth: 2, maxEntries: 120 }).catch(() => null);
    if (!listing?.ok || !Array.isArray(listing.entries)) return null;
    const directories = [...new Set(listing.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path).slice(0, 25))];
    const files = [...new Set(listing.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path))]
      .filter((path) => /package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|README|\.env|src\//i.test(path))
      .slice(0, 12);
    return {
      directories,
      files,
      topLevel: directories.slice(0, 10),
      generated: directories.filter((path) => /node_modules|dist|build|coverage|\.git|vendor/.test(path)).slice(0, 10)
    };
  }

  async buildContextForRequest({ prompt, workspaceTools, projectMetadata, recentMessages = [], force = false, debug = false } = {}) {
    const entries = [];
    const safeProjectMetadata = projectMetadata ? { ...projectMetadata, git: projectMetadata.git ?? { isRepository: false, hasUncommittedChanges: false, branch: null } } : null;
    const metadata = safeProjectMetadata ? createProjectContext(safeProjectMetadata) : null;
    if (metadata) {
      entries.push({ role: 'system', content: metadata });
      this.budget.addText(metadata, { kind: 'file' });
    }

    const shouldSearchRepository = force || REPOSITORY_TOPIC.test(String(prompt ?? '')) || /(?<![\w])\.(?:env|gitignore|forgeignore)(?:\.[\w.-]+)?/i.test(String(prompt ?? ''));
    const repoMap = workspaceTools && !shouldSearchRepository ? await this.buildRepositoryMap(workspaceTools) : null;
    if (repoMap) {
      const summary = [
        'Repository map (metadata only):',
        `Directories: ${repoMap.directories.slice(0, 10).join(', ') || 'n/a'}`,
        `Files: ${repoMap.files.slice(0, 10).join(', ') || 'n/a'}`,
        repoMap.generated.length ? `Ignored/generated areas: ${repoMap.generated.join(', ')}` : 'No generated directories were flagged.'
      ].join('\n');
      entries.push({ role: 'system', content: summary });
      this.budget.addText(summary, { kind: 'file' });
    }
    if (!workspaceTools || !shouldSearchRepository) {
      if (recentMessages.length > 5) {
        const compressed = this.compressConversation(recentMessages);
        const summary = `Recent conversation summary:\n${compressed}`;
        entries.push({ role: 'system', content: summary });
        this.budget.addText(summary, { kind: 'tool' });
      }
      if (debug) this.debugState = { selected: entries.map((entry) => entry.content.split('\n')[0]), excluded: ['node_modules', '.git', '.env'], estimatedTokens: this.budget.usage.estimatedTokens };
      return Object.assign(entries, { debugInfo: this.debugState });
    }

    const repositoryContext = await buildRepositoryContext(workspaceTools, String(prompt ?? ''), { force: true }).catch(() => null);
    if (repositoryContext) {
      const cleaned = this.filterSensitiveContent(repositoryContext);
      entries.push({ role: 'system', content: cleaned });
      this.budget.addText(cleaned, { kind: 'tool' });
    }

    if (recentMessages.length > 5) {
      const compressed = this.compressConversation(recentMessages);
      const summary = `Recent conversation summary:\n${compressed}`;
      entries.push({ role: 'system', content: summary });
      this.budget.addText(summary, { kind: 'tool' });
    }

    if (debug) {
      this.debugState = {
        selected: entries.map((entry) => entry.content.split('\n')[0]),
        excluded: ['node_modules', '.git', '.env'],
        estimatedTokens: this.budget.usage.estimatedTokens
      };
    }

    return Object.assign(entries, { debugInfo: this.debugState });
  }
}

export function buildContextManager(options) {
  return new ContextManager(options);
}
