import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { createForgeApp } from '../src/gui/server.js';
import { ConfigurationError } from '../src/core/config.js';

function fetchJson(server, path) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const port = address && address.port ? address.port : 0;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : {} });
        } catch {
          resolve({ statusCode: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Forge GUI reports configuration issues without crashing the app shell', async () => {
  const app = createForgeApp({
    createSession: async () => {
      throw new ConfigurationError('Configure OPENAI_API_KEY or a local model endpoint.');
    },
    env: {}
  });

  await new Promise((resolve) => app.listen(0, resolve));
  try {
    const response = await fetchJson(app, '/api/status');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.configured, false);
    assert.match(response.body.error, /OPENAI_API_KEY|local model endpoint/i);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
