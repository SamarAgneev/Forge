# Forge GUI Architecture

The GUI is intentionally a frontend client of the existing Forge engine. It does not reimplement the agent loop, policy checks, terminal execution, Git protections, or provider logic.

## Core boundary

- Forge core remains the source of truth for filesystem, provider, approval, verification, and task orchestration.
- The GUI subscribes to structured Forge events and calls the same `Conversation` and service objects used by the CLI.
- The frontend is expected to call the core through a thin bridge instead of parsing terminal text or duplicating permission enforcement.

## Event protocol

The event protocol is versioned in spirit through a stable catalog of message types under `src/gui/event-protocol.js`.

Supported events include:

- `agent_started`
- `thinking_started`
- `assistant_message`
- `tool_requested`
- `permission_requested`
- `tool_started`
- `tool_output`
- `file_changed`
- `command_started`
- `command_output`
- `verification_started`
- `verification_result`
- `agent_completed`
- `agent_error`
- `agent_cancelled`

The GUI should consume these events and render the live workflow without bypassing Forge security and permission checks.
