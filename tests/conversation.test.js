import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/core/conversation.js';
import { loadConfig } from '../src/core/config.js';

test('configuration requires credentials and supplies a default model', () => {
  assert.throws(() => loadConfig({}), /required API key is not configured/);
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: ' test-key ' }), {
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    maxRepairAttempts: 3
  });
  assert.deepEqual(loadConfig({ OPENAI_API_KEY: 'test-key', FORGE_MAX_REPAIR_ATTEMPTS: '2' }), {
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    maxRepairAttempts: 2
  });
  assert.throws(() => loadConfig({ OPENAI_API_KEY: 'test-key', FORGE_MAX_REPAIR_ATTEMPTS: '11' }), /whole number from 1 to 10/);
});

test('conversation retains turns for later prompts', async () => {
  const received = [];
  const provider = {
    async complete(messages) {
      received.push(messages);
      return `Answer ${received.length}`;
    }
  };
  const conversation = new Conversation(provider);

  assert.equal(await conversation.ask('  My project is a shop.  '), 'Answer 1');
  assert.equal(await conversation.ask('Add authentication.'), 'Answer 2');
  assert.deepEqual(received[1], [
    { role: 'user', content: 'My project is a shop.' },
    { role: 'assistant', content: 'Answer 1' },
    { role: 'user', content: 'Add authentication.' }
  ]);
});

test('project metadata is sent separately from persisted conversation messages', async () => {
  let request;
  const projectMetadata = {
    projectName: 'safe-project',
    projectType: 'Node.js',
    languages: ['JavaScript'],
    framework: null,
    packageManager: 'npm',
    git: { isRepository: false, branch: null, hasUncommittedChanges: false },
    workspacePath: 'C:\\Users\\private-user\\safe-project',
    structure: [{ path: '.env', type: 'file' }, { path: 'src/private.js', type: 'file' }]
  };
  const conversation = new Conversation({
    async complete(messages) {
      request = messages;
      return 'A Node.js project.';
    }
  }, { projectMetadata });

  await conversation.ask('What kind of project is this?');

  assert.equal(request[0].role, 'system');
  assert.match(request[0].content, /Project type: Node\.js/);
  assert.doesNotMatch(request[0].content, /private-user|\.env|private\.js/);
  assert.deepEqual(conversation.getMessages(), [
    { role: 'user', content: 'What kind of project is this?' },
    { role: 'assistant', content: 'A Node.js project.' }
  ]);
});

test('conversation rejects empty input without contacting the provider', async () => {
  const conversation = new Conversation({ complete: async () => assert.fail('Provider should not be called') });

  await assert.rejects(conversation.ask('   '), /Enter a message/);
  assert.deepEqual(conversation.getMessages(), []);
});

test('failed model turn is removed so the next prompt has clean history', async () => {
  let shouldFail = true;
  const provider = {
    async complete() {
      if (shouldFail) throw new Error('Model unavailable');
      return 'Recovered';
    }
  };
  const conversation = new Conversation(provider);

  await assert.rejects(conversation.ask('First prompt'), /Model unavailable/);
  shouldFail = false;
  await conversation.ask('Retry prompt');

  assert.deepEqual(conversation.getMessages(), [
    { role: 'user', content: 'Retry prompt' },
    { role: 'assistant', content: 'Recovered' }
  ]);
});
