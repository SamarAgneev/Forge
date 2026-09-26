# Forge

Forge is an open-source AI coding agent foundation. Today, it provides an interactive terminal conversation with an AI model and keeps conversation context for the current run.

## CURRENT FEATURES

- Interactive conversation using OpenAI or a local OpenAI-compatible chat-completions endpoint.
- In-memory conversation history for the current session.
- Clean startup information including the configured model.
- `exit`, `quit`, and Ctrl+C to leave; blank input is ignored.
- Friendly startup, network, and provider error messages.
- `--help` and `--version` commands.
- Configuration through environment variables or a local `.env` file.
- Read-only workspace/project metadata, limited directory structure, Git branch/status, and the `/project` command.
- Workspace-bounded text file reading and focused code search for repository questions.
- AI-proposed file creation and exact-section edits with complete diff previews and explicit approval.
- Conservative development-command execution with a complete command preview and separate approval for each command.
- Explicit project verification with configured test/build/lint/type-check discovery and structured failure analysis.
- Verification after approved edits, with bounded repair proposals that each require separate approval.

Forge can inspect project files and make approved changes, but it never silently modifies files. It reads selected text files for repository questions and sends only focused excerpts to the model, never the whole repository. Supported providers are OpenAI and local OpenAI-compatible chat-completions endpoints. Conversation history is cleared when Forge exits.

### OpenCode-inspired architecture notes

Forge does not fork OpenCode. It performs selective engineering reuse from the official upstream repository `sst/opencode` at commit `696f41bc8e7586657375d53390925fc54c25d34c` (inspected on 2026-09-26). The upstream project is distributed under the MIT license, and Forge keeps its own architecture, configuration, and safety model while adapting a few high-value patterns: structured tool metadata with permission and risk levels, explicit approval gating around tool execution, and provider/tool abstractions that remain registry-driven rather than hardcoded in the agent loop.

The most direct Forge-native adaptation is the tool registry metadata model, which now exposes a stable definition for each tool including permission classification, risk level, and structured input schema. This preserves Forge's existing workflow while making the tool system easier to reason about and extend without weakening safety boundaries.

### Repository Awareness

Forge checks the current directory and a limited number of parent directories for common project indicators, including:

- Node.js/TypeScript: `package.json`, lockfiles, `tsconfig.json`, and common framework configuration files.
- Python: `pyproject.toml`, `requirements.txt`, `Pipfile`, and `setup.py`.
- Rust: `Cargo.toml`.
- Go: `go.mod`.
- Java: `pom.xml` and Gradle build files.
- PHP and Ruby: `composer.json` and `Gemfile`.
- Git repositories: `.git` and read-only local Git queries.

Framework names are reported only when configuration files or corroborating project metadata provide evidence. Start Forge in a workspace and enter `/project` for the detected summary. Forge honors root and nested `.gitignore`, `.ignore`, and `.forgeignore` patterns and skips generated directories such as `node_modules`, `dist`, `build`, and `.git` internals. The structure scan is limited to three directory levels and 300 entries by default; reads of project metadata and ignore rules are capped at 64 KiB total.

Project metadata is kept separate from conversation history. The model receives a short summary of project type, languages, framework, package manager, and repository status. For repository-related questions, Forge searches matching text and reads a few relevant line ranges; those excerpts include workspace-relative paths and line numbers for citations. The workspace path, branch name, and full directory tree are not sent to the model.

### Safe File Reading and Code Search

Forge's internal workspace tools provide `readFile(path)`, `listDirectory(path)`, and `searchCode(query)`. They accept workspace-relative paths, enforce workspace boundaries, skip symlinks and protected/ignored paths, and return structured results. Text search supports exact and case-insensitive matching, filename/extension/directory filters, and line-numbered snippets. Search results and file excerpts are bounded; repository-question retrieval considers at most four files and 12,000 characters of context. The default file read limit is 128 KiB and search skips files over 64 KiB. Binary files and oversized files are reported rather than sent as source text.

Repository search is text-based, not a complete language parser. It can find symbols such as function and class names when they appear in text, but cannot guarantee semantic references or infer behavior absent from the retrieved code. If no relevant code is found, Forge is instructed to say so instead of inventing an answer. Searches are performed on demand with per-request limits; Forge does not maintain a repository index.

### Safe File Changes

For a recognized change request, Forge asks the model for a structured create/edit proposal. It validates workspace-relative paths, rejects ambiguous or missing edit matches, records the original file state, and displays every file and diff before asking for approval. Edits replace exact text that must occur once; unrelated file content is preserved. Multi-file proposals are preflighted and applied as one approved operation. New parent directories are created only when the proposal explicitly includes that step.

Enter `y` or `yes` to apply the complete proposal, `a` to apply all of it, or `n` to reject it. Approval is only interpreted while a proposal is pending; ordinary conversation text is never approval. Creating a protected file requires `y` followed by the exact phrase `CONFIRM PROTECTED`. Existing sensitive files cannot be read or edited by AI-generated patches.

The current process keeps an in-memory snapshot for each successful change operation, and the internal change manager can roll it back if files have not changed since. Snapshots are lost when Forge exits; there is no user-facing undo command yet. Forge does not delete files. After an approved change, it discovers configured verification commands and asks for approval before running each one. A failed check can trigger a bounded repair proposal; each repair diff and each subsequent check require separate approval.

### Safe Terminal Execution

Ask Forge to run a supported development command, such as “Run the tests.” Forge shows the complete planned sequence, then requests approval for each command separately. Enter `y` or `yes` to run the currently displayed command, or `n`/`exit` to cancel it and any remaining commands. Approving one command never approves the next one.

Commands use structured argument arrays and are launched without a shell. The conservative allowlist includes `npm test`, `npm run build|lint|check|typecheck`, `pytest`, `python -m pytest`, `cargo test`, `go test ./...`, selected read-only `git status`/`git diff` forms, version checks, and `pwd`. Shells, command chaining, redirects, substitutions, install commands, unrecognized scripts, and Git write/history operations are blocked. Potentially destructive commands such as `git reset`, `git clean`, and file deletion commands are blocked by policy.

Every command has a timeout (60 seconds by default, capped at five minutes) and bounded stdout/stderr capture (64 KiB total by default). Configure `FORGE_COMMAND_TIMEOUT_MS` to change the default within those bounds. Truncated output is marked. The runner uses the workspace as its working directory, resolves allowlisted executables outside the workspace, passes a limited environment rather than the full process environment, and redacts common credential-shaped output. It is designed for Windows, macOS, and Linux and does not use a general shell.

The command-result structure is passed back to the model for a single summary. No follow-up command runs without its own approval.

### Project Verification and Error Analysis

Ask Forge to “Run the tests” or “Verify this project.” It detects configured checks from project metadata and config files, then proposes only relevant commands through the existing terminal approval flow. A test request selects tests only. Full verification considers configured tests, type checks, builds, and lint checks in that order; each command still requires its own approval. Missing categories are reported as `Not configured`, and commands whose executables are unavailable are not proposed.

Detection currently recognizes Node package scripts (`test`, `build`, `lint`, `typecheck`, and `check`), Python pytest/Ruff/mypy configuration, Cargo projects, Go modules, Maven POMs, and Gradle build files. Node scripts are proposed only when the corresponding script name exists in `package.json`. Python commands require matching project config/dependency/test-file evidence. Other languages without recognized configuration report that verification mode as not configured.

After an approved command, Forge records a structured status, command, exit code, duration, timeout/output-limit state, and bounded stdout/stderr. On failure it cautiously classifies common compiler, type, syntax, test, lint, missing-command/dependency, configuration, runtime, timeout, and environment errors. It parses common TypeScript/JavaScript, Python/pytest, Rust, Go, Java, and stack-trace file locations, validates paths against the workspace, and may include a few nearby source lines. Diagnostics are clues rather than certainty. A failed check after an approved code change can start a repair attempt, up to the configured limit; Forge proposes a diff and requires approval before applying it, then asks approval before verification runs again. A baseline is not currently captured before the initial change, so a pre-existing failure cannot always be distinguished from a regression.

## Git Integration

Forge now includes a safe Git service layer for repository detection, branch/status reporting, diffs, log history, staging, and commit previews. It is read-only by default and it does not alter remotes or perform destructive actions without a high-risk future permission system.

- `/git status` shows the current branch and tracked/untracked/staged/unstaged changes.
- `/git diff` shows the working-tree diff in a bounded, readable format.
- `/git log` shows concise recent commit metadata.
- Staging requires explicit approval and blocks sensitive paths such as `.env`, private keys, and credential-like files.
- Commit preview displays the files and diff summary before asking for approval.
- Commit creation requires explicit approval and refuses merges with conflicts or suspicious file sets.

Forge does not automatically push or modify remote repositories. Remote operations such as `git push`, `git pull`, `git fetch`, and `git clone` are blocked. Destructive Git operations such as `git reset --hard`, `git clean`, `git checkout -- .`, `git restore .`, `git rebase`, and force-branch deletion remain blocked by policy. User changes are treated as protected unless the user explicitly approves a change to the relevant files.

## Focused Context Management

Forge now uses a dedicated context-management layer to keep model requests small, relevant, and budget-aware. The context manager separates:

- conversation context
- repository metadata
- file context and chunked excerpts
- tool-result summaries
- task state and active repair state
- a bounded context budget

This is kept outside the CLI, provider layer, and individual tools so the agent can decide what enters model context without bypassing project safety checks.

### Context budget and model capability

The context manager tracks approximate characters, estimated tokens, message counts, file payloads, and tool-output summaries. It does not assume one universal context window; instead, it uses provider metadata when available and otherwise falls back to a conservative safe default. The provider interface exposes a contextWindow capability when the implementation can provide it.

### Relevance over completeness

Forge does not send the entire repository to the model by default. In the repository-aware path, it first considers the user request, then project metadata, then precise search results, then a small set of high-signal files and code sections. It expands only when the current request and evidence justify more context.

### Repository map and relevance ranking

The repository map is intentionally metadata-oriented, not source-heavy. It tracks directories, important project files, manifests, configuration files, source/test areas, and obvious generated paths. This helps the agent identify likely entry points and relevant areas without reading everything.

File relevance is ranked by a mix of signals: filename, directory, file type, search result score, symbol and keyword overlap, import/test relationships, user-specific paths, and framework conventions. Forge uses these signals to prefer the most relevant evidence while excluding clearly unrelated files.

### Code chunking and progressive retrieval

Large source files are not sent in full. Forge chunks code around function, class, interface, and method boundaries when practical and keeps only the smallest required sections for the current reasoning step. If a later model turn needs more evidence, it can expand to a neighboring file or a narrower code block without preloading all of the repository.

### Conversation compression and task memory

Long-running tasks are compressed into structured summaries that preserve requirements, decisions, changed files, verification status, unresolved issues, and current constraints. This is kept separate from the raw message history and is used only when context pressure requires it.

### Cache and invalidation

Forge keeps a lightweight local cache for file reads and other repeated lookups. Cache entries are invalidated when a file’s content changes, when the Git state is relevant, or when Forge itself modifies the file. This avoids redundant reads while remaining local and simple.

### Debugging and security

When debug mode is enabled, the context manager can report which evidence was selected and which paths were excluded, along with an estimated token budget. Sensitive data is filtered before it reaches the model, protected files stay blocked, and workspace boundaries remain enforced. The context manager is not a backdoor to arbitrary filesystem access.

## PLANNED FEATURES

Forge currently supports a single foreground request and a bounded, approval-gated edit/verify/repair workflow. Future work includes stronger verification baselines, streaming in the CLI, broader model integrations, persistent task recovery, richer Git workflows, IDE integrations, and extensible tools. Automatic repair without approval, background autonomy, Git push/pull, deployment, browser automation, cloud indexing, and plugin marketplaces are not implemented.

## Requirements

- Node.js 20 or newer
- An OpenAI API key, or a reachable local OpenAI-compatible chat-completions endpoint

## Installation

Clone this repository, then install and link the CLI:

```sh
npm install
npm link
```

On Windows PowerShell, use `npm.cmd install` and `npm.cmd link` if the `npm` PowerShell shim is blocked by execution policy. Linking makes the `forge` command available locally. From the repository, `npm start` also starts Forge.

## Configuration

Set the required API key in your shell or in a local `.env` file. To create the file, copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FORGE_PROVIDER` | No | `openai` | Select `openai` or `local`. |
| `OPENAI_API_KEY` | OpenAI only | None | OpenAI API credential. Keep it private and never commit `.env`. |
| `FORGE_MODEL` | No | `gpt-4o-mini` | OpenAI model name; for a local provider, use `MODEL_NAME` or this variable. |
| `MODEL_NAME` | Local only | None | Model name served by the configured local endpoint. |
| `MODEL_BASE_URL` | Local only | None | OpenAI-compatible endpoint base URL, for example `http://localhost:11434/v1`. |
| `MODEL_CONTEXT_WINDOW` | No | Provider default | Optional context-window size for the selected model. |
| `FORGE_DEBUG` | No | Disabled | Set to `1` to show internal error details. |
| `FORGE_COMMAND_TIMEOUT_MS` | No | `60000` | Default command timeout in milliseconds; bounded to five minutes. |
| `FORGE_MAX_REPAIR_ATTEMPTS` | No | `3` | Maximum repair proposals per task, from 1 to 10. Every proposal requires approval. |

## Starting Forge

After configuring OpenAI credentials or a local model endpoint, run:

```sh
forge
```

Or start from the repository with `npm start` (`npm.cmd start` in PowerShell).

Example conversation:

```text
Forge
Open-source AI coding agent
Model: gpt-4o-mini (OpenAI)
Type your request below. Type exit or quit to leave.

> Explain what Forge does.
Thinking...

Forge:
Forge is an interactive AI chat client for developers.

> What can you help me with?
Thinking...

Forge:
I can answer questions and discuss development topics.

> exit
Goodbye.
```

## CLI Commands

- `forge` starts an interactive conversation.
- `forge --help` displays usage and configuration guidance.
- `forge --version` displays the project version.
- `/project` displays detected project metadata and a limited directory structure.

Example repository question:

```text
> Where does Forge prevent path traversal?
Forge:
Workspace-relative paths are checked for traversal before file access (src/core/workspace-policy.js:213).
```

Example approved change:

```text
> Create hello.ts that exports a greeting function.
Forge:
I inspected the workspace and propose: Add a greeting helper.

Files:
- Create hello.ts

Diff:
--- /dev/null
+++ b/hello.ts
@@
+export function greeting() { return "Hello, world!"; }

Apply this complete change set? [y/N/a]
> y
Changes applied successfully.
create: hello.ts
```

Example command approval:

```text
> Run the tests.
Forge:
Forge wants to run: Run the requested development command.
1. npm test [development]

Allow command 1 of 1? [y/N]
> y
Running npm test...

Forge:
Tests completed successfully.

Exit code: 0 (840 ms).

stdout:
PASS tests/example.test.js
```

## Security

Inspection and search tools are read-only. The inspector reads bounded project metadata and ignore rules; file tools open only requested or search-selected text files under the workspace boundary. Absolute/outside paths, traversal, symlinks, `.git` internals, ignored paths, and sensitive files are rejected. Environment files, credentials, tokens, private keys, certificates, Terraform state, and common credential directories are excluded. Binary and oversized files are skipped. Common inline key/token/password assignments are redacted from returned text.

The change manager writes only after explicit REPL approval. It rechecks file hashes and exact patch matches immediately before application, refuses stale patches, stages files in their target directories, and attempts rollback if a multi-file operation fails. New files never overwrite existing files. Paths remain workspace-bounded; symlinks, ignored paths, generated directories, and protected files are blocked. Protected-file creation requires a second confirmation, and existing sensitive files cannot be modified by Forge.

Commands are never launched from model output without a validated plan and explicit approval. No shell command strings are accepted. Approval confirms the displayed top-level command, but a package manager or test/build tool may execute project scripts or plugins under the current user account. Forge does not provide an operating-system sandbox; review commands and project scripts before approving. Git writes, remote operations, shell access, and system-level commands are blocked.

The CLI separately loads `.env` for configuration. `OPENAI_API_KEY` is used by the OpenAI provider and may be passed as a bearer credential to a local compatible endpoint; `.env` values are not included in project metadata, command environments, or model prompts. Command output is treated as untrusted input and common credential-shaped values are redacted before analysis.

## Development

Install dependencies with `npm install`, then run Forge using `npm start`. Tests use Node's built-in test runner and do not require a real API key or network access:

```sh
npm test
```

Forge executes only supported commands after explicit approval. A failed check after an approved code change can lead to a bounded, approval-gated repair proposal. There is no separate lint, type-check, or build script configured in this project.

GitHub Actions runs the automated test suite on Node.js 20 and 22 across Windows, macOS, and Linux. This repository does not currently define separate lint, type-check, or build scripts.

## License

MIT. See [LICENSE](LICENSE).
