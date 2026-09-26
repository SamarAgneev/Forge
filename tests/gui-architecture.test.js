import test from 'node:test';
import assert from 'node:assert/strict';

import { FORGE_EVENT_TYPES, createForgeEvent, ForgeFrontendBridge } from '../src/gui/event-protocol.js';

const eventNames = Array.from(FORGE_EVENT_TYPES);

test('event protocol exposes the structured Forge event catalog', () => {
  assert.ok(eventNames.includes('agent_started'));
  assert.ok(eventNames.includes('tool_requested'));
  assert.ok(eventNames.includes('permission_requested'));
  assert.ok(eventNames.includes('agent_completed'));
});

test('route events from the real conversation through a frontend bridge', async () => {
  const events = [];
  const conversation = {
    ask: async (prompt) => {
      events.push(['ask', prompt]);
      return 'Repository inspected';
    },
    pendingChangeProposal: null,
    approvePendingChange: async () => ({ ok: true, changed: [{ action: 'edit', path: 'src/example.js' }] }),
    approvePendingCommand: async () => ({ ok: true, complete: true, summary: 'tests passed' })
  };

  const bridge = new ForgeFrontendBridge({ conversation, onEvent: (event) => events.push(['event', event.type]) });
  const response = await bridge.sendUserMessage('Inspect the repo');

  assert.equal(response, 'Repository inspected');
  assert.ok(events.some(([kind]) => kind === 'event'));
  assert.ok(events.some(([kind, value]) => kind === 'ask' && value === 'Inspect the repo'));
  assert.ok(events.some(([kind, value]) => kind === 'event' && value === 'assistant_message'));
});

test('createForgeEvent retains type, timestamp and payload metadata', () => {
  const event = createForgeEvent('tool_output', { command: 'npm test', exitCode: 0 });
  assert.equal(event.type, 'tool_output');
  assert.equal(event.payload.command, 'npm test');
  assert.ok(Number.isFinite(event.timestamp));
});
