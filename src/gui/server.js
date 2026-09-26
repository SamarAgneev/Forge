import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { createForgeSession } from './session.js';

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Forge Workspace</title>
    <style>
      :root {
        --bg: #0b1020;
        --panel: #111827;
        --panel-alt: #0f172a;
        --border: #263244;
        --text: #e5eefb;
        --muted: #9bb0c8;
        --accent: #7dd3fc;
        --accent-strong: #38bdf8;
        --success: #34d399;
        --warning: #fbbf24;
        --danger: #f87171;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: linear-gradient(180deg, #0b1020 0%, #0f172a 100%);
        color: var(--text);
        font-family: Inter, Segoe UI, sans-serif;
      }
      .workspace {
        display: grid;
        grid-template-columns: 260px 1fr 340px;
        grid-template-rows: 56px 1fr 220px;
        height: 100vh;
      }
      .topbar {
        grid-column: 1 / span 3;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 18px;
        border-bottom: 1px solid var(--border);
        background: rgba(16, 24, 39, 0.96);
      }
      .brand { font-weight: 700; letter-spacing: 0.04em; }
      .actions { display: flex; gap: 12px; color: var(--muted); }
      .panel {
        border-right: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        background: rgba(17, 24, 39, 0.92);
        overflow: hidden;
      }
      .panel.right { border-right: none; }
      .panel.bottom { grid-column: 1 / span 3; border-right: none; }
      .header {
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .content {
        padding: 14px;
        height: calc(100% - 48px);
        overflow: auto;
      }
      .tree { list-style: none; margin: 0; padding: 0; }
      .tree li { padding: 6px 8px; border-radius: 8px; color: var(--muted); }
      .tree .folder { color: var(--text); font-weight: 600; }
      .chat { display: flex; flex-direction: column; height: 100%; }
      .messages { flex: 1; overflow: auto; padding: 16px; }
      .message { margin-bottom: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(148, 163, 184, 0.08); }
      .message.user { background: rgba(59,130,246,0.14); }
      .composer { display: flex; padding: 12px; border-top: 1px solid var(--border); }
      .composer input {
        flex: 1; background: rgba(15, 23, 42, 0.9); color: var(--text);
        border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
      }
      .composer button {
        margin-left: 10px; background: var(--accent-strong); color: #06111b; border: none; border-radius: 10px; padding: 10px 14px; font-weight: 700;
      }
      .status {
        display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px;
      }
      .badge { display: inline-block; background: rgba(52,211,153,0.12); color: var(--success); border: 1px solid rgba(52,211,153,0.3); border-radius: 999px; padding: 4px 8px; }
      .mono { font-family: ui-monospace, SFMono-Regular, monospace; }
    </style>
  </head>
  <body>
    <div class="workspace">
      <div class="topbar">
        <div class="brand">Forge</div>
        <div class="actions">
          <span>Project</span>
          <span>Model</span>
          <span>Status</span>
        </div>
      </div>

      <aside class="panel">
        <div class="header">Explorer</div>
        <div class="content">
          <ul class="tree">
            <li class="folder">src</li>
            <li>core</li>
            <li>gui</li>
            <li>models</li>
            <li class="folder">tests</li>
          </ul>
        </div>
      </aside>

      <main class="panel">
        <div class="header">Workspace</div>
        <div class="content mono" id="workspace-content">
          <div class="badge">Forge Core Connected</div>
          <p>Workspace ready. The GUI is being backed by the existing Forge engine and a real session bridge.</p>
        </div>
      </main>

      <aside class="panel right">
        <div class="header">Agent</div>
        <div class="chat">
          <div class="messages" id="messages">
            <div class="message">Forge is ready to inspect the project.</div>
          </div>
          <form class="composer" id="composer-form">
            <input id="prompt" placeholder="Ask Forge to inspect or fix the project…" />
            <button type="submit">Send</button>
          </form>
        </div>
      </aside>

      <div class="panel bottom">
        <div class="header">Terminal</div>
        <div class="content mono" id="terminal-output">Forge terminal ready.</div>
        <div class="status"><span>Ready</span><span>•</span><span id="status-line">Idle</span></div>
      </div>
    </div>

    <script type="module">
      const messagesEl = document.getElementById('messages');
      const composerForm = document.getElementById('composer-form');
      const promptEl = document.getElementById('prompt');
      const workspaceContentEl = document.getElementById('workspace-content');
      const terminalOutputEl = document.getElementById('terminal-output');
      const statusLine = document.getElementById('status-line');

      async function appendMessage(text, kind = 'bot') {
        const div = document.createElement('div');
        div.className = 'message ' + kind;
        div.textContent = text;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      async function sendPrompt(prompt) {
        if (!prompt.trim()) return;
        appendMessage(prompt, 'user');
        statusLine.textContent = 'Thinking…';
        try {
          const response = await fetch('/api/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
          });
          const data = await response.json();
          if (data.error) {
            appendMessage(data.error, 'bot');
          } else {
            appendMessage(data.reply || 'No response.', 'bot');
          }
          statusLine.textContent = 'Idle';
        } catch (error) {
          appendMessage(error.message || 'Unable to reach Forge.', 'bot');
          statusLine.textContent = 'Error';
        }
      }

      composerForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = promptEl.value.trim();
        promptEl.value = '';
        await sendPrompt(value);
      });

      fetch('/api/status')
        .then((response) => response.json())
        .then((data) => {
          if (data.project) {
            const project = data.project;
            const languages = Array.isArray(project.languages) ? project.languages.join(', ') : 'N/A';
            workspaceContentEl.innerHTML = '<div class="badge">' + (project.projectType || 'Software project') + '</div><p><strong>Project:</strong> ' + (project.projectName || 'Forge workspace') + '</p><p><strong>Framework:</strong> ' + (project.framework || 'Unknown') + '</p><p><strong>Languages:</strong> ' + languages + '</p>';
          }
          if (data.status) {
            terminalOutputEl.textContent = data.status;
          }
        })
        .catch(() => {
          workspaceContentEl.innerHTML = '<div class="badge">Offline</div><p>The Forge core is unavailable.</p>';
        });
    </script>
  </body>
</html>`;

export function createForgeApp({ env = process.env, createSession = createForgeSession } = {}) {
  let session = null;

  async function ensureSession() {
    if (!session) {
      session = await createSession({ env });
    }
    return session;
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (url.pathname === '/api/status') {
      try {
        const current = await ensureSession();
        const project = current.project;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          configured: true,
          project: {
            projectName: project.projectName,
            projectType: project.projectType,
            framework: project.framework,
            languages: project.languages,
            packageManager: project.packageManager,
            git: project.git
          },
          status: 'Forge core connected and ready.'
        }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          configured: false,
          error: error.message || 'Forge session could not initialize.',
          status: 'Forge needs configuration before the agent can run.'
        }));
      }
      return;
    }

    if (url.pathname === '/api/message') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method not allowed.' }));
        return;
      }

      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const prompt = String(body.prompt ?? '').trim();
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Prompt is required.' }));
          return;
        }

        const current = await ensureSession();
        const reply = await current.conversation.ask(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ reply }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message || 'Forge could not process that request.' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}

export function startForgeGuiServer({ env = process.env, createSession = createForgeSession, port = Number(env.FORGE_GUI_PORT || 3333) } = {}) {
  const server = createForgeApp({ env, createSession });
  server.listen(port, () => {
    console.log(`Forge GUI listening on http://localhost:${port}`);
  });
  return server;
}

const isDirectExecution = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isDirectExecution) {
  startForgeGuiServer({ env: process.env, createSession: createForgeSession });
}
