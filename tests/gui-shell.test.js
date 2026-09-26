import test from 'node:test';
import assert from 'node:assert/strict';

import { createForgeAppShell, createDefaultForgeLayout, FORGE_PANEL_IDS, createForgeWorkspaceState } from '../src/gui/app-shell.js';

test('the Forge app shell exposes a responsive panel layout with default workspace regions', () => {
  const shell = createForgeAppShell();
  assert.equal(shell.layout.sidebar.currentView, 'explorer');
  assert.equal(shell.layout.right.currentView, 'agent');
  assert.equal(shell.layout.bottom.currentView, 'terminal');
  assert.ok(FORGE_PANEL_IDS.explorer);
});

test('the Forge workspace state exposes project metadata, explorer entries, and terminal status', () => {
  const workspace = createForgeWorkspaceState({
    projectName: 'Forge',
    projectType: 'Node.js / TypeScript',
    framework: 'Next.js',
    languages: ['TypeScript'],
    git: { branch: 'main', hasUncommittedChanges: true },
    structure: [
      { path: 'src', type: 'directory' },
      { path: 'src/gui', type: 'directory' },
      { path: 'src/gui/server.js', type: 'file' }
    ]
  });

  assert.equal(workspace.summary.projectName, 'Forge');
  assert.equal(workspace.summary.projectType, 'Node.js / TypeScript');
  assert.ok(workspace.explorer.some((item) => item.path === 'src/gui/server.js'));
  assert.equal(workspace.git.branch, 'main');
  assert.ok(workspace.terminal.some((entry) => entry.includes('Forge')));
});

test('layout helpers toggle collapsed and focus states without mutating the core policy layer', () => {
  const shell = createForgeAppShell();
  shell.toggleSidebar();
  shell.toggleRightPanel();
  shell.toggleBottomPanel();
  shell.setFocusMode('editor');
  shell.setTheme('light');

  assert.equal(shell.layout.sidebar.collapsed, true);
  assert.equal(shell.layout.right.collapsed, true);
  assert.equal(shell.layout.bottom.collapsed, true);
  assert.equal(shell.layout.focusMode, 'editor');
  assert.equal(shell.layout.theme, 'light');
  assert.deepEqual(createDefaultForgeLayout(), {
    sidebar: { width: 280, collapsed: false, currentView: 'explorer' },
    center: { minWidth: 420, panes: ['editor'] },
    right: { width: 360, collapsed: false, currentView: 'agent' },
    bottom: { height: 220, collapsed: false, currentView: 'terminal' },
    focusMode: 'normal',
    theme: 'dark'
  });
});
