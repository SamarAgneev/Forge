import OpenAI from 'openai';
import { ModelProvider, ModelRequest, ModelResponse, ProviderError } from './provider.js';

export class OpenAIProvider extends ModelProvider {
  constructor({
    apiKey,
    model = 'gpt-4o-mini',
    client,
    contextWindow = 128000,
    baseUrl = undefined,
    capabilities = {}
  } = {}) {
    super({
      providerName: 'openai',
      model,
      contextWindow,
      capabilities: {
        textGeneration: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        contextWindow,
        ...capabilities
      }
    });
    if (!apiKey?.trim()) {
      throw new Error('Missing OPENAI_API_KEY. Add it to your environment or .env file.');
    }

    this.apiKey = apiKey.trim();
    this.baseUrl = baseUrl?.trim();
    this.client = client ?? new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {})
    });
  }

  async generate(request) {
    const normalizedRequest = request instanceof ModelRequest ? request : new ModelRequest(request);
    const payload = {
      model: this.model,
      messages: normalizedRequest.toProviderMessages(),
      temperature: undefined,
      tools: undefined,
      max_tokens: undefined,
      stream: Boolean(normalizedRequest.stream)
    };
    if (normalizedRequest.temperature !== undefined) payload.temperature = normalizedRequest.temperature;
    if (normalizedRequest.maxTokens !== undefined) payload.max_tokens = normalizedRequest.maxTokens;
    if (normalizedRequest.tools?.length) {
      payload.tools = normalizedRequest.tools;
      payload.tool_choice = 'auto';
    }
    if (normalizedRequest.contextWindow !== undefined) payload.max_context_tokens = normalizedRequest.contextWindow;
    if (normalizedRequest.topP !== undefined) payload.top_p = normalizedRequest.topP;

    try {
      const response = await this.callWithRetry(async () => this.client.chat.completions.create(payload));
      const message = response?.choices?.[0]?.message ?? {};
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => this.normalizeToolCall(call)).filter(Boolean)
        : [];

      if (!text && toolCalls.length === 0) {
        throw new ProviderError('The model returned an empty or unexpected response.');
      }

      return new ModelResponse({
        text,
        toolCalls,
        finishReason: response?.choices?.[0]?.finish_reason ?? 'stop',
        provider: 'openai',
        usage: response?.usage ?? null,
        metadata: {
          model: this.model,
          request: payload
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error?.status === 401) {
        throw new ProviderError('The API key was rejected. Check OPENAI_API_KEY.', { kind: 'authentication', cause: error });
      }
      if (error?.status === 429) {
        throw new ProviderError('The model request was rate-limited. Check your quota and try again.', { kind: 'rate_limit', cause: error });
      }
      if (error?.name === 'APIConnectionError' || error instanceof TypeError) {
        throw new ProviderError('Could not connect to the model API. Check your network and try again.', { kind: 'network', cause: error });
      }
      if (error?.status === 408 || error?.status === 504) {
        throw new ProviderError('The model request timed out. Try again with a smaller request.', { kind: 'timeout', cause: error });
      }
      if (Number.isInteger(error?.status)) {
        throw new ProviderError(`The model API request failed (HTTP ${error.status}).`, { kind: 'provider_server_error', cause: error });
      }
      throw new ProviderError('The model request failed. Please try again.', { kind: 'provider', cause: error });
    }
  }

  async *stream(request) {
    const normalizedRequest = request instanceof ModelRequest ? request : new ModelRequest({ ...request, stream: true });
    const payload = {
      model: this.model,
      messages: normalizedRequest.toProviderMessages(),
      stream: true
    };
    if (normalizedRequest.temperature !== undefined) payload.temperature = normalizedRequest.temperature;
    if (normalizedRequest.topP !== undefined) payload.top_p = normalizedRequest.topP;
    if (normalizedRequest.maxTokens !== undefined) payload.max_tokens = normalizedRequest.maxTokens;
    if (normalizedRequest.tools?.length) {
      payload.tools = normalizedRequest.tools;
      payload.tool_choice = 'auto';
    }

    try {
      const streamResponse = await this.callWithRetry(async () => this.client.chat.completions.create(payload));
      for await (const chunk of streamResponse) {
        const delta = chunk?.choices?.[0]?.delta ?? {};
        const text = typeof delta.content === 'string' ? delta.content : '';
        if (!text && !delta.tool_calls?.length) continue;
        yield new ModelResponse({
          text,
          toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls.map((call) => this.normalizeToolCall(call)).filter(Boolean) : [],
          finishReason: chunk?.choices?.[0]?.finish_reason ?? 'stop',
          provider: 'openai',
          metadata: { model: this.model }
        });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Streaming failed.', { kind: 'network', cause: error });
    }
  }
}
