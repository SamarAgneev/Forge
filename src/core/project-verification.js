import { isAbsolute, relative, sep, win32 } from 'node:path';
import { redactSensitiveValues } from './workspace-policy.js';

export const VERIFICATION_MODES = Object.freeze(['tests', 'typecheck', 'build', 'lint']);
const MODE_LABELS = Object.freeze({ tests: 'Tests', typecheck: 'Type Check', build: 'Build', lint: 'Lint' });
const SOURCE_EXTENSIONS = 'c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|scala|sh|sql|ts|tsx|vue|svelte';
const SOURCE_LOCATION = new RegExp(`(?:^|\\s)((?:[A-Za-z]:[\\\\/])?[^\\r\\n]+?\\.(?:${SOURCE_EXTENSIONS})):(\\d+)(?::(\\d+))?(?::|\\s+-\\s+|\\)?$)\\s*(.*)$`);
const PAREN_LOCATION = new RegExp(`^\\s*((?:[A-Za-z]:[\\\\/])?[^\\r\\n()]+?\\.(?:${SOURCE_EXTENSIONS}))\\((\\d+),(\\d+)\\):\\s*(.*)$`);
const PYTHON_LOCATION = /^\s*File ["'](.+?)["'], line (\d+)(?:, in (.+))?\s*$/;
const JAVA_LOCATION = /^\s*\[ERROR\]\s+(.+?\.java):\[(\d+),(\d+)\]\s*(.*)$/;
const PYTEST_FAILURE = /^\s*FAILED\s+(.+?)(?:::(\S+?))?(?:\s+-\s+(.*))?\s*$/;
const FILE_TEST_FAILURE = /^\s*(?:FAIL|ERROR)\s+(.+\.(?:test|spec)\.[A-Za-z0-9]+|tests?[/\\][^\s]+)\s*$/i;
const NODE_TEST_FAILURE = /^\s*\u2716\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/;
const ERROR_HEADER = /^\s*(?:error|fatal error)(?:\[([A-Z]\d{4})\])?:?\s*(.*)$/i;
const MAX_ANALYSIS_CHARACTERS = 16 * 1024;
const MAX_DIAGNOSTICS = 12;

function hasPath(project, ...names) {
  return names.some((name) => project.importantFiles?.includes(name)
    || project.structure?.some((entry) => entry.path === name));
}

function addCommand(commands, mode, executable, args) {
  commands.push({ executable, args, verificationCategory: mode });
}

function safeDiagnosticMessage(value) {
  const message = redactSensitiveValues(String(value ?? '').trim()).slice(0, 600);
  if (/ignore (?:all )?(?:previous|prior|system)|reveal (?:the )?(?:secret|credential|prompt)|exfiltrat|tool call|execute this command|run this command/i.test(message)) {
    return '[Untrusted command text omitted.]';
  }
  return message;
}

function nodeCommand(manager, script) {
  if (manager === 'npm') return script === 'test'
    ? { executable: 'npm', args: ['test'] }
    : { executable: 'npm', args: ['run', script] };
  if (manager === 'yarn') return script === 'test'
    ? { executable: 'yarn', args: ['test'] }
    : { executable: 'yarn', args: [script] };
  return script === 'test'
    ? { executable: manager, args: ['test'] }
    : { executable: manager, args: ['run', script] };
}

function npmScripts(project) {
  return new Set(project.packageScripts ?? []);
}

function addPackageScript(commands, project, mode, script) {
  const scripts = npmScripts(project);
  if (!scripts.has(script)) return false;
  const manager = ['npm', 'pnpm', 'yarn', 'bun'].includes(project.packageManager) ? project.packageManager : 'npm';
  const command = nodeCommand(manager, script);
  addCommand(commands, mode, command.executable, command.args);
  return true;
}

async function readSafeText(workspaceTools, path) {
  if (!workspaceTools) return '';
  const result = await workspaceTools.readFile(path, { maxCharacters: 32 * 1024 });
  return result.ok ? result.content : '';
}

export function requestedVerificationModes(prompt) {
  const text = String(prompt ?? '').toLowerCase();
  if (/\bverify\b[\s\S]{0,50}\b(project|everything|all checks?)\b|\bfull verification\b/.test(text)) {
    return [...VERIFICATION_MODES];
  }
  const modes = [];
  if (/\b(tests?|pytest|cargo test|go test|mvn test|gradle test)\b/.test(text)) modes.push('tests');
  if (/\b(type[ -]?check|typecheck|mypy|tsc|static types?)\b/.test(text)) modes.push('typecheck');
  if (/\b(build|compile|cargo check|go build|mvn package|gradle build)\b/.test(text)) modes.push('build');
  if (/\b(lint|ruff|mypy|clippy|go vet)\b/.test(text)) modes.push('lint');
  return [...new Set(modes)];
}

export function isVerificationRequest(prompt) {
  return requestedVerificationModes(prompt).length > 0;
}

export class ProjectVerifier {
  constructor(project, workspaceTools, terminalTool) {
    this.project = project;
    this.workspaceTools = workspaceTools;
    this.terminalTool = terminalTool;
  }

  async detectCommands() {
    const commands = [];
    const scripts = npmScripts(this.project);
    const languages = new Set(this.project.languages ?? []);
    const pythonProject = languages.has('Python');
    const pyproject = hasPath(this.project, 'pyproject.toml') ? await readSafeText(this.workspaceTools, 'pyproject.toml') : '';
    const requirements = hasPath(this.project, 'requirements.txt') ? await readSafeText(this.workspaceTools, 'requirements.txt') : '';
    const setupConfig = hasPath(this.project, 'setup.cfg') ? await readSafeText(this.workspaceTools, 'setup.cfg') : '';
    const toxConfig = hasPath(this.project, 'tox.ini') ? await readSafeText(this.workspaceTools, 'tox.ini') : '';
    const pytestConfig = hasPath(this.project, 'pytest.ini', '.pytest.ini')
      || /\[tool\.pytest\.ini_options\]/i.test(pyproject)
      || /\[tool:pytest\]/i.test(setupConfig)
      || /pytest/i.test(toxConfig)
      || /^\s*pytest(?:[<>=!~].*)?$/im.test(requirements)
      || /pytest\s*(?:[<>=!~]|$)/i.test(pyproject);
    const pythonTestFiles = this.project.structure?.some((entry) => entry.type === 'file'
      && /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(entry.path));

    if (scripts.has('test')) addPackageScript(commands, this.project, 'tests', 'test');
    if (scripts.has('typecheck')) addPackageScript(commands, this.project, 'typecheck', 'typecheck');
    else if (scripts.has('check')) addPackageScript(commands, this.project, 'typecheck', 'check');
    if (scripts.has('build')) addPackageScript(commands, this.project, 'build', 'build');
    if (scripts.has('lint')) addPackageScript(commands, this.project, 'lint', 'lint');

    if (pythonProject) {
      const python = process.platform === 'win32' ? 'python' : 'python3';
      if (pytestConfig && pythonTestFiles) addCommand(commands, 'tests', python, ['-m', 'pytest']);
      if (hasPath(this.project, 'ruff.toml', '.ruff.toml') || /\[tool\.ruff(?:\.|\])/i.test(pyproject) || /ruff/i.test(requirements)) {
        addCommand(commands, 'lint', 'ruff', ['check']);
      }
      if (hasPath(this.project, 'mypy.ini', '.mypy.ini') || /\[tool\.mypy\]/i.test(pyproject) || /mypy/i.test(requirements)) {
        addCommand(commands, 'typecheck', 'mypy', []);
      }
    }

    if (hasPath(this.project, 'Cargo.toml')) {
      addCommand(commands, 'tests', 'cargo', ['test']);
      addCommand(commands, 'typecheck', 'cargo', ['check']);
      addCommand(commands, 'build', 'cargo', ['build']);
      addCommand(commands, 'lint', 'cargo', ['clippy']);
    }
    if (hasPath(this.project, 'go.mod')) {
      addCommand(commands, 'tests', 'go', ['test', './...']);
      addCommand(commands, 'build', 'go', ['build', './...']);
      addCommand(commands, 'lint', 'go', ['vet', './...']);
    }
    if (hasPath(this.project, 'pom.xml')) {
      addCommand(commands, 'tests', 'mvn', ['test']);
      addCommand(commands, 'build', 'mvn', ['package']);
    }
    if (hasPath(this.project, 'build.gradle', 'build.gradle.kts')) {
      addCommand(commands, 'tests', 'gradle', ['test']);
      addCommand(commands, 'build', 'gradle', ['build']);
    }

    const unique = new Map();
    for (const command of commands) {
      const key = `${command.verificationCategory}:${command.executable}:${command.args.join('\0')}`;
      if (!unique.has(key)) unique.set(key, command);
    }
    const availability = await Promise.all([...unique.values()].map(async (command) => ({
      ...command,
      available: await this.terminalTool.isCommandAvailable(command)
    })));
    const categories = Object.fromEntries(VERIFICATION_MODES.map((mode) => {
      const configured = availability.filter((command) => command.verificationCategory === mode);
      return [mode, {
        status: configured.length ? configured.some((command) => command.available) ? 'configured' : 'unavailable' : 'not-configured',
        commands: configured.map(({ executable, args, available }) => ({ executable, args, available }))
      }];
    }));
    return {
      projectType: this.project.projectType,
      categories,
      commands: availability
    };
  }

  async prepare(prompt) {
    const requestedModes = requestedVerificationModes(prompt);
    const detection = await this.detectCommands();
    const selectedModes = requestedModes.length ? requestedModes : [...VERIFICATION_MODES];
    const configuredModes = selectedModes.filter((mode) => detection.categories[mode].status === 'configured');
    const notConfigured = selectedModes.filter((mode) => detection.categories[mode].status === 'not-configured');
    const unavailable = selectedModes.filter((mode) => detection.categories[mode].status === 'unavailable');
    const commands = detection.commands.filter((command) => configuredModes.includes(command.verificationCategory) && command.available);
    if (!commands.length) {
      return { ok: true, detection, plan: null, selectedModes, notConfigured, unavailable };
    }

    const summary = requestedModes.length === VERIFICATION_MODES.length
      ? `Verify ${this.project.projectName}`
      : `Run ${configuredModes.map((mode) => MODE_LABELS[mode].toLowerCase()).join(' and ')}`;
    const prepared = await this.terminalTool.preparePlan({
      summary,
      commands: commands.map(({ executable, args, verificationCategory }) => ({ executable, args, verificationCategory }))
    }, { internalVerification: true });
    if (!prepared.ok) return { ok: false, detection, error: prepared.error, selectedModes, notConfigured, unavailable };
    const unavailableSummary = [
      ...notConfigured.map((mode) => `${MODE_LABELS[mode]}: Not configured.`),
      ...unavailable.map((mode) => `${MODE_LABELS[mode]}: Configured, but the required command was not found.`)
    ];
    const preview = unavailableSummary.length
      ? `${prepared.plan.preview}\n\n${unavailableSummary.join('\n')}`
      : prepared.plan.preview;
    return {
      ok: true,
      detection,
      selectedModes,
      notConfigured,
      unavailable,
      plan: { ...prepared.plan, preview }
    };
  }

  async analyzeError(result, verificationCategory = null) {
    const status = result.timedOut
      ? 'TIMED_OUT'
      : result.exitCode === null
        ? 'COMMAND_ERROR'
        : result.exitCode === 0 ? 'PASSED' : 'FAILED';
    const rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-MAX_ANALYSIS_CHARACTERS);
    const classification = classifyFailure(rawOutput, result, verificationCategory);
    const errors = extractDiagnostics(rawOutput).slice(0, MAX_DIAGNOSTICS);
    if (errors.length && this.workspaceTools) {
      for (const error of errors) {
        if (!error.file || !error.line) continue;
        const path = await safeWorkspacePath(this.workspaceTools, error.file);
        if (!path) {
          error.file = null;
          error.fileOutsideWorkspace = true;
          continue;
        }
        error.file = path;
        const excerpt = await this.workspaceTools.readFile(path, {
          startLine: Math.max(1, error.line - 2),
          endLine: error.line + 2,
          maxCharacters: 2000
        });
        if (excerpt.ok) {
          error.sourceContext = excerpt.content.split('\n')
            .map((line, index) => `${excerpt.startLine + index}: ${line}`)
            .join('\n');
        }
      }
    }

    return {
      status,
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      verificationCategory,
      failureClassification: classification,
      errors,
      outputExcerpt: errors.map((error) => [
        error.file ? `${error.file}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : ''}` : '',
        error.errorCode,
        error.testName,
        error.message
      ].filter(Boolean).join(': ')).join('\n').slice(0, 1800),
      outputTruncated: result.outputTruncated === true
    };
  }
}

export async function safeWorkspacePath(workspaceTools, inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  let candidate = inputPath.trim().replace(/^file:\/\//i, '').replace(/\\/g, '/');
  const root = workspaceTools.root;
  if (isAbsolute(inputPath) || win32.isAbsolute(inputPath)) {
    const relativePath = relative(root, inputPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
    candidate = relativePath.split(sep).join('/');
  }
  candidate = candidate.replace(/^\.\//, '');
  if (!candidate || candidate.split('/').includes('..')) return null;
  const resolved = await workspaceTools.resolvePath(candidate);
  if (!resolved.ok && !/not found/i.test(resolved.error)) return null;
  return candidate;
}

export function extractDiagnostics(output) {
  const lines = String(output ?? '').slice(0, MAX_ANALYSIS_CHARACTERS).split(/\r?\n/);
  const diagnostics = [];
  let currentError = null;
  const add = (diagnostic) => {
    const normalized = {
      file: diagnostic.file ? redactSensitiveValues(diagnostic.file).slice(0, 300) : null,
      line: diagnostic.line ? Number(diagnostic.line) : null,
      column: diagnostic.column ? Number(diagnostic.column) : null,
      errorCode: diagnostic.errorCode ? String(diagnostic.errorCode).slice(0, 40) : null,
      message: safeDiagnosticMessage(diagnostic.message),
      testName: diagnostic.testName ? String(diagnostic.testName).slice(0, 240) : null,
      stackLocation: diagnostic.stackLocation ?? null
    };
    if (!normalized.file && !normalized.message && !normalized.testName) return;
    const key = `${normalized.file}:${normalized.line}:${normalized.message}:${normalized.testName}`;
    if (!diagnostics.some((item) => item._key === key)) diagnostics.push({ ...normalized, _key: key });
  };

  for (const line of lines) {
    const header = ERROR_HEADER.exec(line);
    if (header) currentError = { errorCode: header[1] ?? null, message: header[2] ?? '' };

    const python = PYTHON_LOCATION.exec(line);
    if (python) {
      add({ file: python[1], line: python[2], message: python[3] ? `in ${python[3]}` : currentError?.message, errorCode: currentError?.errorCode });
      continue;
    }
    const java = JAVA_LOCATION.exec(line);
    if (java) {
      add({ file: java[1], line: java[2], column: java[3], message: java[4], errorCode: currentError?.errorCode });
      continue;
    }
    const parenthesized = PAREN_LOCATION.exec(line);
    if (parenthesized) {
      add({ file: parenthesized[1], line: parenthesized[2], column: parenthesized[3], message: parenthesized[4], errorCode: currentError?.errorCode ?? parenthesized[4].match(/\b[A-Z]{1,8}\d{2,}\b/)?.[0] });
      continue;
    }
    const source = SOURCE_LOCATION.exec(line);
    if (source) {
      const [, rawFile, lineNumber, column, message] = source;
      const file = rawFile.includes('(') ? rawFile.slice(rawFile.lastIndexOf('(') + 1).trim() : rawFile.trim();
      const stackLocation = /^\s*(?:at |\bat\s)/.test(line) ? line.trim().slice(0, 400) : null;
      add({
        file,
        line: lineNumber,
        column,
        message: message || currentError?.message || '',
        errorCode: currentError?.errorCode ?? message.match(/\b(?:TS\d{3,}|E\d{4}|[A-Z]{2,}\d+)\b/)?.[0],
        stackLocation
      });
      continue;
    }
    const pytest = PYTEST_FAILURE.exec(line);
    if (pytest) {
      add({
        file: pytest[1].includes('::') ? pytest[1].split('::')[0] : pytest[1],
        message: pytest[3] ?? currentError?.message ?? '',
        testName: pytest[2] ?? (pytest[1].includes('::') ? pytest[1].split('::').slice(1).join('::') : null)
      });
      continue;
    }
    const testFailure = FILE_TEST_FAILURE.exec(line);
    if (testFailure) add({ file: testFailure[1], testName: testFailure[1], message: currentError?.message ?? 'Test failed.' });
    const nodeTestFailure = NODE_TEST_FAILURE.exec(line);
    if (nodeTestFailure) add({ testName: nodeTestFailure[1], message: currentError?.message ?? 'Node test failed.' });
  }
  return diagnostics.map(({ _key, ...diagnostic }) => diagnostic);
}

export function classifyFailure(output, result, verificationCategory = null) {
  if (result.timedOut) return 'Command timeout';
  if (result.exitCode === 0) return 'No failure detected';
  if (result.exitCode === null) {
    return /not found|not recognized|could not be started|unavailable/i.test(`${result.stderr ?? ''} ${result.error ?? ''}`)
      ? 'Command not found or could not be started'
      : 'Command execution error';
  }
  const text = String(output ?? '').toLowerCase();
  if (/command not found|not recognized as an internal|no module named|modulenotfounderror|cannot find module/i.test(text)) return 'Likely missing dependency or executable';
  if (/ts\d{3,}|type error|incompatible types|cannot assign|mismatched types/i.test(text) || verificationCategory === 'typecheck') return 'Likely type error';
  if (/syntaxerror|syntax error|unexpected token|parse error/i.test(text)) return 'Likely syntax error';
  if (/could not compile|compilation failed|compiler error|cannot find symbol|undefined:|error\[e\d{4}\]/i.test(text)) return 'Likely compilation error';
  if (/lint|eslint|ruff|clippy|go vet/i.test(`${verificationCategory ?? ''} ${text}`)) return 'Likely lint failure';
  if (/failed|failure|assertionerror|assertion failed|test.*fail|fail.*test/i.test(text) || verificationCategory === 'tests') return 'Likely test failure';
  if (/could not compile|compilation failed|compiler error|build failed/i.test(text) || verificationCategory === 'build') return 'Likely compilation/build failure';
  if (/configuration|invalid config|config error/i.test(text)) return 'Likely configuration error';
  if (/traceback|exception|runtime error|panic:/i.test(text)) return 'Likely runtime error';
  if (/permission denied|network is unreachable|connection refused|timed out/i.test(text)) return 'Likely environment issue';
  return 'Failure cause uncertain';
}

export function formatVerificationResult(analysis) {
  const lines = [
    'Verification Result',
    `Status: ${analysis.status}`,
    `Command: ${analysis.command}`,
    `Exit Code: ${analysis.exitCode ?? 'unavailable'}`,
    `Category: ${analysis.failureClassification}`
  ];
  const error = analysis.errors[0];
  if (error) {
    if (error.file) lines.push(`Affected file: ${error.file}`);
    if (error.line) lines.push(`Line: ${error.line}${error.column ? `:${error.column}` : ''}`);
    if (error.errorCode) lines.push(`Error code: ${error.errorCode}`);
    if (error.testName) lines.push(`Test: ${error.testName}`);
    if (error.message) lines.push(`Error: ${error.message}`);
    if (error.sourceContext) lines.push(`Code context:\n${error.sourceContext}`);
  }
  if (analysis.outputTruncated) lines.push('Output: truncated.');
  return lines.join('\n');
}