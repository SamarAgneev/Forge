import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runRepl } from '../src/cli/repl.js';
import { Conversation } from '../src/core/conversation.js';
import { ProviderError } from '../src/models/provider.js';

function createOutput(chunks) {
  return new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
}

test('REPL displays a response and exits once when stdin closes after exit', async () => {
  const chunks = [];
  const output = createOutput(chunks);
  const conversation = { ask: async () => 'Model reply' };

  await runRepl({
    input: Readable.from(['Explain this project\n', 'exit\n'], { objectMode: false }),
    output,
    conversation,
    model: 'gpt-4o-mini'
  });

  const rendered = chunks.join('');
  assert.match(rendered, /Forge\nOpen-source AI coding agent/);
  assert.match(rendered, /Model: gpt-4o-mini \(OpenAI\)/);
  assert.match(rendered, /Thinking\.\.\./);
  assert.match(rendered, /Model reply/);
  assert.equal(rendered.split('Goodbye.').length - 1, 1);
});

test('REPL skips blank input and continues after exit commands only', async () => {
  const chunks = [];
  let calls = 0;
  await runRepl({
    input: Readable.from(['\n   \n  Explain Forge  \nquit\n'], { objectMode: false }),
    output: createOutput(chunks),
    conversation: {
      async ask(prompt) {
        calls += 1;
        assert.equal(prompt, 'Explain Forge');
        return 'A terminal chat client.';
      }
    }
  });

  assert.equal(calls, 1);
  assert.match(chunks.join(''), /A terminal chat client\./);
});

test('REPL handles /project without sending it to the conversation provider', async () => {
  const chunks = [];
  let calls = 0;
  await runRepl({
    input: Readable.from(['/project\nexit\n'], { objectMode: false }),
    output: createOutput(chunks),
    project: {
      displayPath: '~/projects/example',
      projectName: 'example',
      isProject: true,
      projectType: 'Node.js',
      languages: ['JavaScript'],
      framework: 'React',
      packageManager: 'npm',
      git: { isRepository: true, branch: 'main', hasUncommittedChanges: true },
      structure: [{ path: 'src', type: 'directory' }, { path: 'package.json', type: 'file' }],
      structureTruncated: false
    },
    conversation: { ask: async () => { calls += 1; return 'unexpected'; } }
  });

  const rendered = chunks.join('');
  assert.equal(calls, 0);
  assert.match(rendered, /Workspace: ~\/projects\/example/);
  assert.match(rendered, /Project: example/);
  assert.match(rendered, /Framework: React/);
  assert.match(rendered, /Git: Yes \(branch main, uncommitted changes\)/);
  assert.match(rendered, /src\//);
});

test('REPL carries conversation context across successful turns', async () => {
  const chunks = [];
  const requests = [];
  const conversation = new Conversation({
    async complete(messages) {
      requests.push(messages);
      return `Answer ${requests.length}`;
    }
  });

  await runRepl({
    input: Readable.from(['Explain Forge.\nWhat did I ask?\nexit\n'], { objectMode: false }),
    output: createOutput(chunks),
    conversation
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: 'user', content: 'Explain Forge.' },
    { role: 'assistant', content: 'Answer 1' },
    { role: 'user', content: 'What did I ask?' }
  ]);
  assert.match(chunks.join(''), /Answer 1/);
  assert.match(chunks.join(''), /Answer 2/);
});

test('REPL presents safe network and provider errors', async () => {
  const chunks = [];
  let calls = 0;
  await runRepl({
    input: Readable.from(['network\nprovider\nexit\n'], { objectMode: false }),
    output: createOutput(chunks),
    conversation: {
      async ask() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError('Internal network detail', { kind: 'network' });
        }
        throw new Error('Internal provider detail');
      }
    }
  });

  const rendered = chunks.join('');
  assert.match(rendered, /Forge could not reach the AI provider/);
  assert.match(rendered, /Forge received an error from the AI provider\./);
  assert.doesNotMatch(rendered, /Internal (network|provider) detail/);
});

test('REPL displays internal error details only in debug mode', async () => {
  const chunks = [];
  await runRepl({
    input: Readable.from(['request\nexit\n'], { objectMode: false }),
    output: createOutput(chunks),
    conversation: { ask: async () => { throw new Error('Diagnostic detail'); } },
    debug: true
  });

  assert.match(chunks.join(''), /Diagnostic detail/);
});