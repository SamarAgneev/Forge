import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/models/openai-provider.js';
import { MockProvider, ModelRequest, ModelResponse, ModelProvider, ProviderError } from '../src/models/provider.js';
import { loadConfig, getModelStatus, createModelProvider } from '../src/core/config.js';

const messages = [{ role: 'user', content: 'Hello' }];

function fakeClient(responseOrError) {
  return {
    chat: {
      completions: {
        create: async () => {
          if (responseOrError instanceof Error) throw responseOrError;
          return responseOrError;
        }
      }
    }
  };
}

test('provider interface accepts a normalized request and returns normalized response', async () => {
  const provider = new MockProvider({ model: 'mock-fast' });
  const request = new ModelRequest({
    system: 'You are useful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [{ type: 'function', function: { name: 'project_info', parameters: { type: 'object', properties: {} } } }],
    temperature: 0.2
  });

  const response = await provider.generate(request);
  assert.ok(response instanceof ModelResponse);
  assert.equal(response.text, 'Mock response');
  assert.equal(response.provider, 'mock');
  assert.deepEqual(response.toolCalls, []);
  assert.equal(provider.supportsCapability('toolCalling'), false);
});

test('provider requires an API key', () => {
  assert.throws(() => new OpenAIProvider({}), /Missing OPENAI_API_KEY/);
});

test('provider sends configured model and returns response text', async () => {
  let request;
  const client = {
    chat: {
      completions: {
        create: async (value) => {
          request = value;
          return { choices: [{ message: { content: '  Hello from Forge  ' } }] };
        }
      }
    }
  };
  const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'test-model', client });

  assert.equal(await provider.complete(messages), 'Hello from Forge');
  assert.deepEqual(request, { model: 'test-model', messages, temperature: undefined, tools: undefined, max_tokens: undefined, stream: false });
});

test('provider gives a useful message for an invalid API key', async () => {
  const error = Object.assign(new Error('Unauthorized'), { status: 401 });
  const provider = new OpenAIProvider({ apiKey: 'test-key', client: fakeClient(error) });

  await assert.rejects(provider.complete(messages), /API key was rejected/);
});

test('provider identifies network failures', async () => {
  const error = Object.assign(new Error('Connection failed'), { name: 'APIConnectionError' });
  const provider = new OpenAIProvider({ apiKey: 'test-key', client: fakeClient(error) });

  await assert.rejects(provider.complete(messages), /Check your network/);
});

test('provider reports model service failures without exposing internals', async () => {
  const error = Object.assign(new Error('Internal server details'), { status: 500 });
  const provider = new OpenAIProvider({ apiKey: 'test-key', client: fakeClient(error) });

  await assert.rejects(provider.complete(messages), (failure) => {
    assert.match(failure.message, /HTTP 500/);
    assert.doesNotMatch(failure.message, /Internal server details/);
    return true;
  });
});

test('provider rejects an unexpected response shape', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', client: fakeClient({ choices: [] }) });

  await assert.rejects(provider.complete(messages), ProviderError);
});

test('configuration supports provider selection, model selection, and local endpoints', () => {
  assert.deepEqual(loadConfig({ FORGE_PROVIDER: 'openai', OPENAI_API_KEY: ' test-key ', FORGE_MODEL: ' gpt-4o-mini ' }), {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    baseUrl: undefined,
    contextWindow: null,
    fallback: null,
    maxRepairAttempts: 3
  });

  assert.deepEqual(loadConfig({ FORGE_PROVIDER: 'local', MODEL_BASE_URL: 'http://localhost:11434/v1', MODEL_NAME: ' llama3.2 ' }), {
    provider: 'local',
    model: 'llama3.2',
    apiKey: null,
    baseUrl: 'http://localhost:11434/v1',
    contextWindow: null,
    fallback: null,
    maxRepairAttempts: 3
  });

  assert.throws(() => loadConfig({ FORGE_PROVIDER: 'local', MODEL_BASE_URL: 'http://localhost:11434/v1' }), /Missing model name/);
  assert.throws(() => loadConfig({ FORGE_PROVIDER: 'openai' }), /required API key/);
});

test('capability metadata surfaces tool-calling, streaming, and context window', () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', contextWindow: 200000, client: fakeClient({ choices: [{ message: { content: 'ok' } }] }) });
  provider.capabilities.toolCalling = true;
  provider.capabilities.streaming = true;

  assert.equal(provider.supportsCapability('toolCalling'), true);
  assert.equal(provider.supportsCapability('streaming'), true);
  assert.equal(provider.getCapabilities().contextWindow, 200000);
});

test('mock provider simulates normal tool calls, malformed calls, and provider failures', async () => {
  const toolRequest = new MockProvider({ behavior: 'tool_request' });
  const validCall = await toolRequest.generate(new ModelRequest({ messages }));
  assert.equal(validCall.toolCalls[0].name, 'project_info');

  const malformedCall = new MockProvider({ behavior: 'malformed_tool_call' });
  const malformed = await malformedCall.generate(new ModelRequest({ messages }));
  assert.equal(malformed.toolCalls[0].name, null);
  assert.equal(malformed.toolCalls[0].arguments, '{invalid-json');

  const failing = new MockProvider({ model: 'mock-failing', behavior: 'failure' });
  await assert.rejects(failing.generate(new ModelRequest({ messages: [{ role: 'user', content: 'hi' }] })), /simulated failure/);

  const rateLimited = new MockProvider({ model: 'mock-rate-limit', behavior: 'rate_limit' });
  await assert.rejects(rateLimited.generate(new ModelRequest({ messages: [{ role: 'user', content: 'hi' }] })), /rate limited/i);

  const timedOut = new MockProvider({ model: 'mock-timeout', behavior: 'timeout' });
  await assert.rejects(timedOut.generate(new ModelRequest({ messages: [{ role: 'user', content: 'hi' }] })), /timed out/i);
});

test('factory creates a configured provider and exposes current model status', () => {
  const config = loadConfig({ FORGE_PROVIDER: 'local', MODEL_NAME: 'qwen2.5', MODEL_BASE_URL: 'http://localhost:11434/v1' });
  const provider = createModelProvider(config);
  assert.equal(provider.providerName, 'local');
  assert.equal(provider.model, 'qwen2.5');

  const status = getModelStatus(config);
  assert.equal(status.provider, 'local');
  assert.equal(status.model, 'qwen2.5');
  assert.match(status.message, /local/i);
});
