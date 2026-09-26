# Contributing to Forge

Thanks for helping improve Forge. Keep changes focused, preserve the workspace and command safety boundaries, and include tests for behavior changes.

## Development Setup

- Install Node.js 20 or newer.
- Run `npm ci` to install the locked dependencies.
- Run `npm test` before opening a pull request. The suite uses Node's built-in test runner and does not require an API key.
- Run Forge locally with `npm start`. OpenAI requests require `OPENAI_API_KEY`; local provider configuration is documented in the README.

## Pull Requests

- Describe the problem and the observable behavior change.
- Add or update isolated tests for the changed behavior, especially for workspace access, file writes, command execution, approval, and Git operations.
- Never include credentials, private repository content, or generated dependency/build output.
- Do not add a command, write operation, or model capability that bypasses validation and explicit approval.
- Update the README when user-visible behavior or configuration changes.
- If a change adapts a pattern from another project, document the provenance in the third-party notices and keep the adaptation clearly marked as Forge-specific rather than a fork.

There are currently no separate lint, type-check, or build scripts. Keep the existing JavaScript style and ensure the automated test suite passes on supported platforms.