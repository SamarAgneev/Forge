export const FORGE_PANEL_IDS = Object.freeze({
  explorer: 'explorer',
  editor: 'editor',
  agent: 'agent',
  terminal: 'terminal',
  problems: 'problems',
  git: 'git'
});

export const DEFAULT_FORGE_LAYOUT = Object.freeze({
  sidebar: {
    width: 280,
    collapsed: false,
    currentView: 'explorer'
  },
  center: {
    minWidth: 420,
    panes: ['editor']
  },
  right: {
    width: 360,
    collapsed: false,
    currentView: 'agent'
  },
  bottom: {
    height: 220,
    collapsed: false,
    currentView: 'terminal'
  },
  focusMode: 'normal',
  theme: 'dark'
});

export class ForgeLayoutState {
  constructor(layout = DEFAULT_FORGE_LAYOUT) {
    this.layout = {
      ...JSON.parse(JSON.stringify(DEFAULT_FORGE_LAYOUT)),
      ...JSON.parse(JSON.stringify(layout ?? {}))
    };
  }

  setTheme(theme) {
    this.layout.theme = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark';
    return this.layout.theme;
  }

  toggleSidebar() {
    this.layout.sidebar.collapsed = !this.layout.sidebar.collapsed;
    return this.layout.sidebar.collapsed;
  }

  toggleRightPanel() {
    this.layout.right.collapsed = !this.layout.right.collapsed;
    return this.layout.right.collapsed;
  }

  toggleBottomPanel() {
    this.layout.bottom.collapsed = !this.layout.bottom.collapsed;
    return this.layout.bottom.collapsed;
  }

  setFocusMode(mode) {
    this.layout.focusMode = mode === 'editor' || mode === 'agent' || mode === 'terminal' ? mode : 'normal';
    return this.layout.focusMode;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.layout));
  }
}

export function createDefaultForgeLayout() {
  return new ForgeLayoutState().snapshot();
}

export function createForgeWorkspaceState({
  projectName = 'Forge',
  projectType = 'Software project',
  framework = null,
  languages = [],
  git = { branch: null, hasUncommittedChanges: false },
  structure = [],
  status = 'Forge terminal ready.'
} = {}) {
  const explorer = Array.isArray(structure) ? structure.map((entry, index) => ({
    id: `${entry.path || 'item'}-${index}`,
    path: entry.path || `item-${index}`,
    type: entry.type === 'directory' ? 'directory' : 'file',
    label: entry.path ? entry.path.split('/').pop() : `item-${index}`
  })) : [];

  const terminal = [
    'Forge terminal ready.',
    `Project: ${projectName}`,
    `Type: ${projectType}`,
    framework ? `Framework: ${framework}` : 'Framework: Not detected',
    languages.length ? `Languages: ${languages.join(', ')}` : 'Languages: Not detected',
    git?.branch ? `Branch: ${git.branch}` : 'Branch: not initialized',
    git?.hasUncommittedChanges ? 'Git status: uncommitted changes detected.' : 'Git status: clean working tree.'
  ];

  return {
    summary: {
      projectName,
      projectType,
      framework,
      languages,
      status
    },
    explorer,
    git: {
      branch: git?.branch ?? null,
      hasUncommittedChanges: Boolean(git?.hasUncommittedChanges)
    },
    terminal,
    status
  };
}

export function createForgeAppShell() {
  return new ForgeLayoutState();
}
