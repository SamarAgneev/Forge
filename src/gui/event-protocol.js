export const FORGE_EVENT_TYPES = new Set([
  'agent_started',
  'thinking_started',
  'assistant_message',
  'tool_requested',
  'permission_requested',
  'tool_started',
  'tool_output',
  'file_changed',
  'command_started',
  'command_output',
  'verification_started',
  'verification_result',
  'agent_completed',
  'agent_error',
  'agent_cancelled'
]);

export function createForgeEvent(type, payload = {}, meta = {}) {
  if (!FORGE_EVENT_TYPES.has(type)) {
    throw new Error(`Unsupported Forge event type: ${type}`);
  }
  return {
    type,
    timestamp: meta.timestamp ?? Date.now(),
    sequence: meta.sequence ?? 0,
    payload: payload ?? {}
  };
}

export class ForgeFrontendBridge {
  constructor({ conversation, onEvent = () => {} } = {}) {
    this.conversation = conversation;
    this.onEvent = onEvent;
    this.sequence = 0;
  }

  emit(type, payload = {}, meta = {}) {
    const event = createForgeEvent(type, payload, { ...meta, sequence: this.sequence += 1 });
    this.onEvent(event);
    return event;
  }

  async sendUserMessage(prompt) {
    if (!this.conversation || typeof this.conversation.ask !== 'function') {
      throw new Error('A conversation instance is required to send a message.');
    }
    this.emit('agent_started', { prompt });
    this.emit('thinking_started', { prompt });
    const response = await this.conversation.ask(prompt);
    this.emit('assistant_message', { content: response });
    this.emit('agent_completed', { prompt, response });
    return response;
  }
}
