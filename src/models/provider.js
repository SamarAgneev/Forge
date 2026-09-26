export class ModelCapabilities {
  constructor(capabilities = {}) {
    this.textGeneration = capabilities.textGeneration ?? true;
    this.streaming = capabilities.streaming ?? false;
    this.toolCalling = capabilities.toolCalling ?? false;
    this.structuredOutput = capabilities.structuredOutput ?? false;
    this.vision = capabilities.vision ?? false;
    this.contextWindow = capabilities.contextWindow ?? null;
    this.estimatedTokens = capabilities.estimatedTokens ?? true;
    this.supportsProgressiveRetrieval = capabilities.supportsProgressiveRetrieval ?? true;
  }
}

export class ModelRequest {
  constructor({
    system = '',
    messages = [],
    tools = [],
    temperature = undefined,
    topP = undefined,
    maxTokens = undefined,
    contextWindow = undefined,
    stream = false,
    ...metadata
  } = {}) {
    this.system = typeof system === 'string' ? system : '';
    this.messages = Array.isArray(messages) ? messages : [];
    this.tools = Array.isArray(tools) ? tools : [];
    this.temperature = temperature;
    this.topP = topP;
    this.maxTokens = maxTokens;
    this.contextWindow = contextWindow;
    this.stream = Boolean(stream);
    this.metadata = metadata;
  }

  toProviderMessages() {
    const entries = [];
    if (this.system?.trim()) entries.push({ role: 'system', content: this.system.trim() });
    for (const message of this.messages) {
      if (!message || typeof message !== 'object') continue;
      entries.push({ ...message });
    }
    return entries;
  }
}

export class ModelResponse {
  constructor({
    text = '',
    toolCalls = [],
    finishReason = 'stop',
    provider = 'unknown',
    usage = null,
    metadata = {},
    error = null
  } = {}) {
    this.text = typeof text === 'string' ? text : '';
    this.toolCalls = Array.isArray(toolCalls) ? toolCalls : [];
    this.finishReason = finishReason;
    this.provider = provider;
    this.usage = usage;
    this.metadata = metadata ?? {};
    this.error = error ?? null;
  }
}

export class ModelProvider {
  constructor({
    providerName = 'unknown',
    model = 'unknown',
    contextWindow = null,
    capabilities = {}
  } = {}) {
    this.providerName = providerName;
    this.model = model;
    this.contextWindow = Number(contextWindow) || null;
    this.capabilities = new ModelCapabilities({
      contextWindow: this.contextWindow,
      ...capabilities
    });
  }

  getCapabilities() {
    return { ...this.capabilities, contextWindow: this.contextWindow ?? this.capabilities.contextWindow ?? null };
  }

  supportsCapability(name) {
    return Boolean(this.capabilities?.[name]);
  }

  async generate() {
    throw new Error('ModelProvider.generate() must be implemented by a provider.');
  }

  async *stream(request) {
    const response = await this.generate(request);
    yield response;
  }

  async complete(messages) {
    const request = messages instanceof ModelRequest ? messages : new ModelRequest({ messages });
    const response = await this.generate(request);
    if (!response || typeof response.text !== 'string') {
      throw new ProviderError('The model returned an empty or unexpected response.');
    }
    return response.text.trim();
  }

  normalizeToolCall(call) {
    if (!call || typeof call !== 'object') return null;
    if (call.type === 'function' && call.function) {
      const args = call.function.arguments ?? '{}';
      return {
        id: call.id ?? null,
        type: 'function',
        name: call.function.name ?? null,
        arguments: typeof args === 'string' ? args : JSON.stringify(args)
      };
    }
    if (call.function && typeof call.function === 'object') {
      return {
        id: call.id ?? null,
        type: 'function',
        name: call.function.name ?? null,
        arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {})
      };
    }
    return {
      id: call.id ?? null,
      type: 'raw',
      arguments: JSON.stringify(call)
    };
  }

  async callWithRetry(operation, { retries = 2, delayMs = 250 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError
          ? ['network', 'rate_limit', 'timeout', 'provider_server_error', 'model_unavailable'].includes(error.kind)
          : true;
        if (!retryable || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

export class ProviderError extends Error {
  constructor(message, { kind = 'provider', cause = null, ...options } = {}) {
    super(message, options);
    this.name = 'ProviderError';
    this.kind = kind;
    this.cause = cause ?? null;
  }
}

export class MockProvider extends ModelProvider {
  constructor({
    model = 'mock-model',
    behavior = 'normal',
    contextWindow = 128000,
    capabilities = {}
  } = {}) {
    super({
      providerName: 'mock',
      model,
      contextWindow,
      capabilities: {
        textGeneration: true,
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
        contextWindow,
        ...capabilities
      }
    });
    this.behavior = behavior;
  }

  async generate(request) {
    const normalizedRequest = request instanceof ModelRequest ? request : new ModelRequest(request);
    if (this.behavior === 'failure') {
      throw new ProviderError('The mock provider simulated failure.', { kind: 'provider_server_error' });
    }
    if (this.behavior === 'rate_limit') {
      throw new ProviderError('The mock provider is rate limited. Please wait and retry.', { kind: 'rate_limit' });
    }
    if (this.behavior === 'timeout') {
      throw new ProviderError('The mock provider timed out while waiting for a response.', { kind: 'timeout' });
    }
    if (this.behavior === 'tool_request') {
      return new ModelResponse({
        text: 'Tool request generated.',
        toolCalls: [{ id: 'call_1', type: 'function', name: 'project_info', arguments: JSON.stringify({}) }],
        provider: 'mock',
        metadata: { model: this.model }
      });
    }
    if (this.behavior === 'malformed_tool_call') {
      return new ModelResponse({
        text: '',
        toolCalls: [{ id: 'call_invalid', type: 'function', name: null, arguments: '{invalid-json' }],
        provider: 'mock',
        metadata: { model: this.model }
      });
    }

    return new ModelResponse({
      text: 'Mock response',
      provider: 'mock',
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      metadata: {
        request: normalizedRequest,
        model: this.model
      }
    });
  }
}
