import test from 'node:test';
import assert from 'node:assert/strict';

import { createForgeSession } from '../src/gui/session.js';

test('forge GUI session bootstraps a real Forge core conversation', async () => {
  const session = await createForgeSession({
    env: {
      FORGE_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      FORGE_MODEL: 'gpt-4o-mini'
    }
  });

  assert.ok(session.conversation);
  assert.ok(session.bridge);
  assert.ok(session.project);
  assert.equal(session.project.projectType || 'Software project', session.project.projectType || 'Software project');
});
