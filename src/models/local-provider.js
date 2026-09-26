import { ModelProvider, ModelRequest, ModelResponse, ProviderError } from './provider.js';

export class LocalModelProvider extends ModelProvider {
  constructor({
    model,
    baseUrl,
    apiKey = null,
    client = null,
    contextWindow = null,
    capabilities = {}
  } = {}) {
    const providerName = 'local';
    super({
      providerName,
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

    if (!model?.trim()) {
      throw new Error('Missing model name for the local provider. Set MODEL_NAME or FORGE_MODEL.');
    }
    if (!baseUrl?.trim()) {
      throw new Error('Missing local model base URL. Set MODEL_BASE_URL or FORGE_BASE_URL.');
    }

    this.apiKey = apiKey?.trim() || null;
    this.baseUrl = baseUrl.trim().replace(/\/$/, '');
    this.client = client ?? {
      fetch: (...args) => fetch(...args)
    };
  }

  async generate(request) {
    const normalizedRequest = request instanceof ModelRequest ? request : new ModelRequest(request);
    if (normalizedRequest.tools?.length && !this.supportsCapability('toolCalling')) {
      throw new ProviderError('This local model does not support native tool calling.', { kind: 'unsupported_capability' });
    }

    const payload = {
      model: this.model,
      messages: normalizedRequest.messages,
      temperature: normalizedRequest.temperature ?? undefined,
      max_tokens: normalizedRequest.maxTokens ?? undefined,
      stream: Boolean(normalizedRequest.stream),
      ...(normalizedRequest.tools?.length ? { tools: normalizedRequest.tools } : {})
    };

    let response;
    try {
      response = await this.callWithRetry(async () => {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const result = await this.client.fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });

        if (!result.ok) {
          const detail = await result.text().catch(() => '');
          if (result.status === 401) {
            throw new ProviderError('The local model rejected the request. Check the configured credentials or endpoint.', { kind: 'authentication', cause: new Error(detail || 'Unauthorized') });
          }
          if (result.status === 429) {
            throw new ProviderError('The local model is rate-limited. Wait and retry later.', { kind: 'rate_limit', cause: new Error(detail || 'Rate limited') });
          }
          if (result.status >= 500) {
            throw new ProviderError('The local model server is unavailable right now.', { kind: 'provider_server_error', cause: new Error(detail || 'Server error') });
          }
          throw new ProviderError('The local model request could not be completed.', { kind: 'invalid_request', cause: new Error(detail || 'Local provider failure') });
        }
        return result.json();
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('The local model request failed.', { kind: 'provider', cause: error });
    }

    const message = response?.choices?.[0]?.message ?? {};
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => this.normalizeToolCall(call)).filter(Boolean)
      : [];

    return new ModelResponse({
      text: content,
      toolCalls,
      finishReason: response?.choices?.[0]?.finish_reason ?? 'stop',
      provider: this.providerName,
      usage: response?.usage ?? null,
      metadata: {
        model: this.model,
        baseUrl: this.baseUrl
      }
    });
  }

  async *stream(request) {
    const normalizedRequest = request instanceof ModelRequest ? request : new ModelRequest(request);
    const payload = {
      model: this.model,
      messages: normalizedRequest.messages,
      temperature: normalizedRequest.temperature ?? undefined,
      max_tokens: normalizedRequest.maxTokens ?? undefined,
      stream: true,
      ...(normalizedRequest.tools?.length ? { tools: normalizedRequest.tools } : {})
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.callWithRetry(async () => {
      const result = await this.client.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      if (!result.ok) {
        const detail = await result.text().catch(() => '');
        throw new ProviderError(`Local model request failed with HTTP ${result.status}.`, { kind: 'provider_server_error', cause: new Error(detail || 'Local streaming failure') });
      }
      return result.body;
    });

    const reader = response?.getReader?.();
    if (!reader) {
      yield await this.generate({ ...normalizedRequest, stream: false });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n');
      buffer = chunks.pop() ?? '';
      for (const rawChunk of chunks) {
        const line = rawChunk.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payloadText = line.replace(/^data:\s*/, '');
        if (payloadText === '[DONE]') return;
        try {
          const parsed = JSON.parse(payloadText);
          const text = parsed?.choices?.[0]?.delta?.content ?? '';
          if (text) {
            yield new ModelResponse({ text, provider: this.providerName, metadata: { model: this.model } });
          }
        } catch {
          // Ignore malformed stream frames and continue.
        }
      }
    }
  }
}
