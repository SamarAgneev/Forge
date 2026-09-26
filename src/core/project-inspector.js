import { execFile } from 'node:child_process';
import { opendir, open, lstat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { WorkspacePolicy } from './workspace-policy.js';

const execFileAsync = promisify(execFile);
const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 3,
  maxEntries: 300,
  maxMetadataBytes: 64 * 1024,
  rootSearchDepth: 8
});
const MAX_DIRECTORY_ENTRIES = 500;
const IGNORE_FILE_LIMIT = 16 * 1024;
const MANIFEST_LIMIT = 24 * 1024;
const PROJECT_MARKERS = new Set([
  '.git', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock', 'uv.lock', 'setup.py', 'pytest.ini', 'tox.ini', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs', 'angular.json',
  'next.config.js', 'next.config.mjs', 'next.config.ts', 'vite.config.js', 'vite.config.ts', 'nuxt.config.js',
  'nuxt.config.ts', 'svelte.config.js', 'svelte.config.ts', 'astro.config.js', 'astro.config.mjs', 'manage.py', 'artisan',
  'pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'ruff.toml', '.ruff.toml', 'mypy.ini', '.mypy.ini'
]);
const IMPORTANT_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'Cargo.toml', 'Cargo.lock', 'go.mod',
  'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'Gemfile.lock',
  'README', 'README.md', 'README.rst', 'Makefile', 'setup.py', 'uv.lock', 'poetry.lock', 'Pipfile.lock',
  'angular.json', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'vite.config.js', 'vite.config.ts',
  'nuxt.config.js', 'nuxt.config.ts', 'svelte.config.js', 'astro.config.js', 'astro.config.mjs', 'manage.py',
  'artisan', 'mix.exs', 'pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml'
]);
async function listDirectory(directory, limit = MAX_DIRECTORY_ENTRIES) {
  const entries = [];
  let truncated = false;
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    return { entries, truncated };
  }
  return { entries, truncated };
}

async function findProjectRoot(cwd, rootSearchDepth) {
  let directory = cwd;
  for (let depth = 0; depth <= rootSearchDepth; depth += 1) {
    const { entries } = await listDirectory(directory);
    const names = new Set(entries.map((entry) => entry.name));
    if ([...PROJECT_MARKERS].some((marker) => names.has(marker))) {
      return { path: directory, names };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const { entries } = await listDirectory(cwd);
  return { path: cwd, names: new Set(entries.map((entry) => entry.name)) };
}

async function readBoundedText(filePath, state, limit) {
  const allowance = Math.min(limit, state.remainingBytes);
  if (allowance <= 0) return { text: '', truncated: true };

  let handle;
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) return { text: '', truncated: false };
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(allowance + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > allowance;
    const usedBytes = Math.min(bytesRead, allowance);
    state.remainingBytes -= usedBytes;
    return { text: buffer.subarray(0, usedBytes).toString('utf8'), truncated };
  } catch {
    return { text: '', truncated: false };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanStructure(root, { maxDepth, maxEntries }, policy) {
  const structure = [];
  let truncated = false;

  async function visit(directory, depth) {
    if (depth > maxDepth || structure.length >= maxEntries) {
      truncated = true;
      return;
    }

    const basePath = relative(root, directory);
  await policy.rulesForDirectory(basePath);
    const listing = await listDirectory(directory, Math.max(1, Math.min(MAX_DIRECTORY_ENTRIES, maxEntries - structure.length)));
    truncated ||= listing.truncated;
    listing.entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of listing.entries) {
      if (structure.length >= maxEntries) {
        truncated = true;
        return;
      }
      const isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink() || policy.isSensitiveName(entry.name)) continue;
      if (isDirectory && policy.isExcludedDirectoryName(entry.name)) continue;

      const absolutePath = resolve(directory, entry.name);
      const entryPath = relative(root, absolutePath);
      if (await policy.isPathIgnored(entryPath, isDirectory)) continue;

      const portablePath = entryPath.split(sep).join('/').replace(/[\u0000-\u001f\u007f]/g, '?');
      structure.push({ path: portablePath, type: isDirectory ? 'directory' : 'file' });
      if (isDirectory && depth < maxDepth) {
        await visit(absolutePath, depth + 1);
      } else if (isDirectory && depth >= maxDepth) {
        truncated = true;
      }
    }
  }

  await visit(root, 0);
  return { structure, truncated };
}

async function readPackageMetadata(root, rootNames, state) {
  if (!rootNames.has('package.json')) return {};
  const { text, truncated } = await readBoundedText(resolve(root, 'package.json'), state, MANIFEST_LIMIT);
  if (truncated) return {};
  try {
    const manifest = JSON.parse(text);
    return {
      packageManager: typeof manifest.packageManager === 'string' ? manifest.packageManager : null,
      packageScripts: manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
        ? Object.entries(manifest.scripts)
          .filter(([name, value]) => /^[A-Za-z0-9:_-]{1,80}$/.test(name) && typeof value === 'string')
          .map(([name]) => name)
          .sort()
        : [],
      dependencies: new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {})
      ])
    };
  } catch {
    return {};
  }
}

function detectPackageManager(names, packageManagerField) {
  const declared = packageManagerField?.match(/^(npm|pnpm|yarn|bun)@/i)?.[1];
  if (declared) return declared.toLowerCase();
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
  if (names.has('package-lock.json')) return 'npm';
  if (names.has('uv.lock')) return 'uv';
  if (names.has('poetry.lock')) return 'Poetry';
  if (names.has('Pipfile') || names.has('Pipfile.lock')) return 'pipenv';
  if (names.has('requirements.txt')) return 'pip';
  if (names.has('Cargo.toml')) return 'cargo';
  if (names.has('go.mod')) return 'Go modules';
  if (names.has('pom.xml')) return 'Maven';
  if (names.has('build.gradle') || names.has('build.gradle.kts')) return 'Gradle';
  if (names.has('composer.json')) return 'Composer';
  if (names.has('Gemfile')) return 'Bundler';
  return names.has('package.json') ? 'npm' : null;
}

function detectLanguages(names, structure) {
  const allNames = [...names, ...structure.map((entry) => entry.path.split('/').pop())];
  const hasExtension = (extension) => allNames.some((name) => name.toLowerCase().endsWith(extension));
  const languages = [];
  if (names.has('package.json') || names.has('package-lock.json') || hasExtension('.js') || hasExtension('.mjs') || hasExtension('.jsx')) {
    languages.push('JavaScript');
  }
  if (names.has('tsconfig.json') || hasExtension('.ts') || hasExtension('.tsx')) languages.push('TypeScript');
  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('Pipfile') || names.has('poetry.lock') || names.has('uv.lock') || names.has('setup.py') || hasExtension('.py')) {
    languages.push('Python');
  }
  if (names.has('Cargo.toml') || hasExtension('.rs')) languages.push('Rust');
  if (names.has('go.mod') || hasExtension('.go')) languages.push('Go');
  if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts') || hasExtension('.java')) {
    languages.push('Java');
  }
  if (names.has('composer.json') || hasExtension('.php')) languages.push('PHP');
  if (names.has('Gemfile') || hasExtension('.rb')) languages.push('Ruby');
  return languages;
}

function detectFramework(names, structure, dependencies) {
  const paths = structure.map((entry) => entry.path.toLowerCase());
  const hasNextLayout = paths.some((path) => /^(app|pages)\//.test(path));
  if (names.has('next.config.js') || names.has('next.config.mjs') || names.has('next.config.ts') || (dependencies.has('next') && hasNextLayout)) return 'Next.js';
  if (names.has('angular.json')) return 'Angular';
  if (names.has('nuxt.config.js') || names.has('nuxt.config.ts')) return 'Nuxt';
  if (names.has('astro.config.mjs') || names.has('astro.config.js')) return 'Astro';
  if (names.has('svelte.config.js')) return 'SvelteKit';
  if (names.has('manage.py')) return 'Django';
  if (names.has('artisan')) return 'Laravel';

  const fileNames = structure.filter((entry) => entry.type === 'file').map((entry) => entry.path.toLowerCase());
  if (dependencies.has('react') && fileNames.some((name) => /\.(jsx|tsx)$/.test(name))) return 'React';
  if (dependencies.has('vue') && fileNames.some((name) => name.endsWith('.vue'))) return 'Vue';
  return null;
}

function projectTypeFor(languages, isProject) {
  if (!languages.length) return isProject ? 'Software project' : 'Not detected';
  if (languages.includes('JavaScript') && languages.includes('TypeScript')) return 'Node.js / TypeScript';
  if (languages.includes('JavaScript')) return 'Node.js';
  return languages.join(' / ');
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024,
    timeout: 1200,
    windowsHide: true
  });
  return stdout.trim();
}

async function inspectGit(cwd) {
  let root;
  try {
    root = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return { isRepository: false, branch: null, hasUncommittedChanges: false };
  }

  const [branch, status] = await Promise.all([
    runGit(root, ['branch', '--show-current']).catch(() => ''),
    runGit(root, ['status', '--porcelain', '--untracked-files=normal']).catch(() => null)
  ]);
  return {
    isRepository: true,
    root: resolve(root),
    branch: branch || null,
    hasUncommittedChanges: status === null ? null : status.length > 0
  };
}

function pathForDisplay(path, home = homedir()) {
  const absolutePath = resolve(path);
  const homeRelative = relative(home, absolutePath);
  const insideHome = homeRelative === '' || (!homeRelative.startsWith(`..${sep}`) && homeRelative !== '..');
  const displayPath = insideHome
    ? homeRelative ? `~${sep}${homeRelative}` : '~'
    : absolutePath;
  return displayPath.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function safeText(value, maxLength = 100) {
  return String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

export async function inspectProject({ cwd = process.cwd(), limits = {} } = {}) {
  const normalizedLimits = {
    maxDepth: Math.max(0, Math.min(8, limits.maxDepth ?? DEFAULT_LIMITS.maxDepth)),
    maxEntries: Math.max(1, Math.min(1000, limits.maxEntries ?? DEFAULT_LIMITS.maxEntries)),
    maxMetadataBytes: Math.max(0, Math.min(256 * 1024, limits.maxMetadataBytes ?? DEFAULT_LIMITS.maxMetadataBytes)),
    rootSearchDepth: Math.max(0, Math.min(16, limits.rootSearchDepth ?? DEFAULT_LIMITS.rootSearchDepth))
  };
  const workspacePath = resolve(cwd);
  const workspace = await findProjectRoot(workspacePath, normalizedLimits.rootSearchDepth);
  const root = workspace.path;
  const state = { remainingBytes: normalizedLimits.maxMetadataBytes };
  const policy = new WorkspacePolicy(root, { state });
  const scan = await scanStructure(root, normalizedLimits, policy);
  const packageMetadata = await readPackageMetadata(root, workspace.names, state);
  const languages = detectLanguages(workspace.names, scan.structure);
  const isProject = [...workspace.names].some((name) => PROJECT_MARKERS.has(name));
  const framework = detectFramework(workspace.names, scan.structure, packageMetadata.dependencies ?? new Set());
  const git = await inspectGit(workspacePath);
  const importantFiles = [...workspace.names]
    .filter((name) => !policy.isSensitiveName(name) && IMPORTANT_FILES.has(name))
    .sort((left, right) => left.localeCompare(right));
  const projectName = safeText(basename(root), 100) || 'workspace';

  return {
    workspacePath,
    displayPath: pathForDisplay(workspacePath),
    projectRoot: root,
    projectName,
    isProject,
    projectType: projectTypeFor(languages, isProject),
    languages,
    framework,
    packageManager: detectPackageManager(workspace.names, packageMetadata.packageManager),
    packageScripts: packageMetadata.packageScripts ?? [],
    importantFiles,
    directories: scan.structure.filter((entry) => entry.type === 'directory').map((entry) => entry.path),
    structure: scan.structure,
    structureTruncated: scan.truncated,
    git
  };
}

export function createProjectContext(project) {
  const gitStatus = project.git.isRepository
    ? project.git.hasUncommittedChanges === null
      ? 'Git repository; working-tree status unavailable.'
      : project.git.hasUncommittedChanges ? 'Git repository with uncommitted changes.' : 'Git repository with a clean working tree.'
    : 'Not a Git repository.';
  return [
    'Read-only workspace metadata detected by Forge:',
    `Project: ${safeText(project.projectName)}`,
    `Project type: ${safeText(project.projectType)}`,
    `Languages: ${project.languages.length ? project.languages.map((language) => safeText(language, 40)).join(', ') : 'Not detected'}`,
    `Framework: ${safeText(project.framework || 'Not detected')}`,
    `Package manager: ${safeText(project.packageManager || 'Not detected')}`,
    `Configured package scripts: ${project.packageScripts?.length ? project.packageScripts.map((name) => safeText(name, 40)).join(', ') : 'None detected'}`,
    `Repository: ${gitStatus}`,
    'This metadata was collected separately from source code; it may be incomplete.'
  ].join('\n');
}

export function formatProjectSummary(project, { maxDisplayedEntries = 60 } = {}) {
  const lines = [
    `Project: ${project.isProject ? project.projectName : 'No recognizable project detected'}`,
    `Workspace: ${project.displayPath}`,
    `Type: ${project.projectType}`,
    `Language: ${project.languages.length ? project.languages.join(', ') : 'Not detected'}`,
    `Framework: ${project.framework || 'Not detected'}`,
    `Package manager: ${project.packageManager || 'Not detected'}`
  ];

  if (!project.git.isRepository) {
    lines.push('Git: No');
  } else if (project.git.hasUncommittedChanges === null) {
    lines.push(`Git: Yes${project.git.branch ? ` (branch ${safeText(project.git.branch)})` : ''}; status unavailable`);
  } else {
    const status = project.git.hasUncommittedChanges ? ', uncommitted changes' : ', clean';
    lines.push(`Git: Yes${project.git.branch ? ` (branch ${safeText(project.git.branch)}${status})` : ` (${status.slice(2)})`}`);
  }

  lines.push('', 'Structure:');
  const entries = project.structure.slice(0, maxDisplayedEntries);
  if (entries.length === 0) lines.push('(empty or inaccessible)');
  for (const entry of entries) {
    const depth = entry.path.split('/').length - 1;
    const name = entry.path.split('/').pop();
    lines.push(`${'  '.repeat(depth)}${safeText(name, 160)}${entry.type === 'directory' ? '/' : ''}`);
  }
  if (project.structure.length > entries.length || project.structureTruncated) {
    lines.push('... (structure listing limited)');
  }
  return lines.join('\n');
}