import { randomUUID } from 'node:crypto';

export const TaskState = Object.freeze({
  IDLE: 'IDLE',
  UNDERSTANDING: 'UNDERSTANDING',
  INSPECTING: 'INSPECTING',
  PLANNING: 'PLANNING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPLYING: 'APPLYING',
  VERIFYING: 'VERIFYING',
  ANALYZING: 'ANALYZING',
  ANALYZING_FAILURE: 'ANALYZING_FAILURE',
  PLANNING_REPAIR: 'PLANNING_REPAIR',
  AWAITING_REPAIR_APPROVAL: 'AWAITING_REPAIR_APPROVAL',
  APPLYING_REPAIR: 'APPLYING_REPAIR',
  REVERIFYING: 'REVERIFYING',
  REPAIR_LIMIT_REACHED: 'REPAIR_LIMIT_REACHED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export class AgentTask {
  constructor({ request, workspace, projectMetadata, context = {} } = {}) {
    this.id = randomUUID();
    this.request = String(request ?? '').trim();
    this.workspace = workspace ?? null;
    this.projectMetadata = projectMetadata ?? null;
    this.state = TaskState.IDLE;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.context = {
      inspectedFiles: [],
      searchResults: [],
      relevantFiles: [],
      plan: [],
      proposedChanges: [],
      approvalState: null,
      executedCommands: [],
      verificationResults: [],
      errors: [],
      finalResult: null,
      notes: [],
      repairHistory: [],
      repairAttempt: 0,
      currentRepair: null,
      lastFailure: null,
      recentChanges: [],
      ...context
    };
  }

  snapshot() {
    return {
      id: this.id,
      request: this.request,
      workspace: this.workspace,
      projectMetadata: this.projectMetadata ? {
        projectName: this.projectMetadata.projectName,
        projectType: this.projectMetadata.projectType,
        languages: this.projectMetadata.languages,
        packageManager: this.projectMetadata.packageManager,
        framework: this.projectMetadata.framework,
        git: this.projectMetadata.git
      } : null,
      state: this.state,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      context: {
        inspectedFiles: [...this.context.inspectedFiles],
        searchResults: [...this.context.searchResults],
        relevantFiles: [...this.context.relevantFiles],
        plan: [...this.context.plan],
        proposedChanges: [...this.context.proposedChanges],
        approvalState: this.context.approvalState,
        executedCommands: [...this.context.executedCommands],
        verificationResults: [...this.context.verificationResults],
        errors: [...this.context.errors],
        finalResult: this.context.finalResult,
        notes: [...this.context.notes],
        repairHistory: [...this.context.repairHistory],
        repairAttempt: this.context.repairAttempt,
        currentRepair: this.context.currentRepair ? { ...this.context.currentRepair } : null,
        lastFailure: this.context.lastFailure ? { ...this.context.lastFailure } : null,
        recentChanges: [...this.context.recentChanges]
      }
    };
  }
}

export class TaskOrchestrator {
  constructor({ projectMetadata, workspaceTools, changeManager, terminalTool, projectVerifier, maxRepairAttempts = 3 } = {}) {
    this.projectMetadata = projectMetadata ?? null;
    this.workspaceTools = workspaceTools ?? null;
    this.changeManager = changeManager ?? null;
    this.terminalTool = terminalTool ?? null;
    this.projectVerifier = projectVerifier ?? null;
    this.currentTask = null;
    this.history = [];
    const configuredRepairLimit = Number(maxRepairAttempts);
    this.maxRepairAttempts = Number.isInteger(configuredRepairLimit)
      ? Math.min(10, Math.max(1, configuredRepairLimit))
      : 3;
  }

  beginTask(request, context = {}) {
    const task = new AgentTask({ request, workspace: context.workspace ?? null, projectMetadata: context.projectMetadata ?? this.projectMetadata, context });
    this.currentTask = task;
    this.history.push(task.snapshot());
    this.updateTaskState(task, TaskState.UNDERSTANDING, 'Task started.');
    return task;
  }

  updateTaskState(task, nextState, notes = '') {
    if (!task || task !== this.currentTask) return task;
    task.state = nextState;
    task.updatedAt = new Date().toISOString();
    if (notes) task.context.notes.push(String(notes));
    this.history.push(task.snapshot());
    return task;
  }

  recordInspection(task, { relevantFiles = [], searchResults = [], inspectedFiles = [] } = {}) {
    if (!task) return task;
    task.context.relevantFiles = [...new Set([...task.context.relevantFiles, ...relevantFiles])];
    task.context.searchResults = [...task.context.searchResults, ...searchResults];
    task.context.inspectedFiles = [...new Set([...task.context.inspectedFiles, ...inspectedFiles])];
    task.updatedAt = new Date().toISOString();
    return task;
  }

  setPlan(task, plan = []) {
    if (!task) return task;
    task.context.plan = Array.isArray(plan) ? plan.map((item) => String(item)) : [];
    task.updatedAt = new Date().toISOString();
    return task;
  }

  setProposal(task, proposal = []) {
    if (!task) return task;
    task.context.proposedChanges = Array.isArray(proposal) ? proposal.map((item) => ({ ...item })) : [];
    task.updatedAt = new Date().toISOString();
    return task;
  }

  setApprovalState(task, approvalState) {
    if (!task) return task;
    task.context.approvalState = approvalState;
    task.updatedAt = new Date().toISOString();
    return task;
  }

  recordRecentChange(task, change = {}) {
    if (!task) return task;
    task.context.recentChanges = [...task.context.recentChanges, { ...change, timestamp: new Date().toISOString() }].slice(-12);
    task.updatedAt = new Date().toISOString();
    return task;
  }

  cancelRepair(task, reason = 'Repair cancelled by the user.') {
    if (!task) return null;
    task.context.notes.push(String(reason));
    task.updatedAt = new Date().toISOString();
    this.updateTaskState(task, TaskState.CANCELLED, reason);
    return task;
  }

  async prepareVerification(task, prompt) {
    if (!task || !this.projectVerifier) return { ok: false, error: 'Verification manager is unavailable.' };
    this.updateTaskState(task, TaskState.VERIFYING, 'Preparing verification for the approved change.');
    return this.projectVerifier.prepare(prompt);
  }

  async applyApproval(task, { approved = false, protectedConfirmation = false } = {}) {
    if (!task) return { ok: false, error: 'There is no active task.' };
    if (!approved) {
      this.updateTaskState(task, TaskState.CANCELLED, 'Task cancelled before approval.');
      return { ok: true, cancelled: true };
    }
    this.updateTaskState(task, TaskState.APPLYING, 'Applying the approved change proposal.');
    task.context.approvalState = { status: 'approved', protectedConfirmation };
    return { ok: true, status: 'approved' };
  }

  async validateToolCall(toolName, args = {}) {
    const toolNameString = typeof toolName === 'string' ? toolName.trim() : '';
    if (!toolNameString) {
      return { ok: false, error: 'Tool name is required.' };
    }
    const allowedTools = new Set(['project_info', 'list_directory', 'search_code', 'read_file', 'create_file', 'edit_file', 'write_file', 'run_command', 'run_commands', 'verify_project', 'git_status', 'git_diff', 'git_log', 'git_stage', 'git_commit']);
    if (!allowedTools.has(toolNameString)) {
      return { ok: false, error: `Tool is not allowed by the agent policy: ${toolNameString}` };
    }
    if (toolNameString === 'project_info' && !this.projectMetadata) return { ok: false, error: 'Project metadata is unavailable.' };
    if (toolNameString === 'run_command' || toolNameString === 'run_commands') {
      if (!this.terminalTool) return { ok: false, error: 'Command execution is unavailable.' };
      const request = toolNameString === 'run_command'
        ? { commands: [{ executable: args.executable, args: args.args ?? [] }], summary: args.summary ?? 'Run the requested command.' }
        : { commands: Array.isArray(args.commands) ? args.commands : [], summary: args.summary ?? 'Run the requested command sequence.' };
      const prepared = await this.terminalTool.preparePlan(request);
      return prepared.ok
        ? { ok: true, plan: prepared.plan }
        : { ok: false, error: prepared.error };
    }
    return { ok: true, allowed: true };
  }

  publicSummary(task) {
    if (!task) return null;
    return {
      id: task.id,
      state: task.state,
      request: task.request,
      plan: task.context.plan,
      approvalState: task.context.approvalState,
      verificationResults: task.context.verificationResults,
      finalResult: task.context.finalResult,
      repairHistory: [...task.context.repairHistory],
      repairAttempt: task.context.repairAttempt,
      maxRepairAttempts: this.maxRepairAttempts
    };
  }

  beginRepairAttempt(task, failure = {}) {
    if (!task) return { ok: false, error: 'There is no active task.' };
    const attempt = Number(task.context.repairAttempt ?? 0) + 1;
    if (attempt > this.maxRepairAttempts) {
      task.context.currentRepair = { attempt, limitReached: true, failure };
      task.context.lastFailure = { ...failure, attempt, limitReached: true };
      this.updateTaskState(task, TaskState.REPAIR_LIMIT_REACHED, `Repair limit reached after ${attempt - 1} attempts.`);
      return { ok: true, attempt, limitReached: true, maxRepairAttempts: this.maxRepairAttempts };
    }
    task.context.recentChanges = [...task.context.recentChanges].slice(-8);
    task.context.repairAttempt = attempt;
    task.context.lastFailure = { ...failure, attempt, timestamp: new Date().toISOString() };
    task.context.currentRepair = {
      attempt,
      failure: { ...failure, attempt },
      proposal: null,
      approved: false,
      applied: false,
      completed: false,
      limitReached: false
    };
    task.context.repairHistory.push({
      attempt,
      command: failure.command ?? null,
      exitCode: failure.exitCode ?? null,
      status: failure.status ?? 'FAILED',
      error: failure.stderr ?? failure.error ?? null,
      timestamp: new Date().toISOString()
    });
    this.updateTaskState(task, TaskState.ANALYZING_FAILURE, `Analyzing verification failure for repair attempt ${attempt}.`);
    return { ok: true, attempt, limitReached: false, maxRepairAttempts: this.maxRepairAttempts, failure: task.context.lastFailure };
  }

  submitRepairProposal(task, proposal = {}) {
    if (!task) return { ok: false, error: 'There is no active task.' };
    const currentRepair = task.context.currentRepair ?? { attempt: task.context.repairAttempt ?? 1, failure: {} };
    currentRepair.proposal = proposal ?? {};
    currentRepair.approved = false;
    task.context.currentRepair = currentRepair;
    task.context.proposedChanges = Array.isArray(proposal.files) ? proposal.files.map((item) => ({ ...item })) : [];
    this.updateTaskState(task, TaskState.AWAITING_REPAIR_APPROVAL, `Repair proposal prepared for approval on attempt ${currentRepair.attempt}.`);
    return { ok: true, proposal: currentRepair.proposal, attempt: currentRepair.attempt };
  }

  async approveRepair(task, { approved = false } = {}) {
    if (!task) return { ok: false, error: 'There is no active task.' };
    const currentRepair = task.context.currentRepair;
    if (!currentRepair || !currentRepair.proposal) {
      return { ok: false, error: 'There is no pending repair proposal.' };
    }
    if (approved !== true) {
      this.updateTaskState(task, TaskState.AWAITING_REPAIR_APPROVAL, 'Repair proposal was not approved.');
      return { ok: false, approved: false, attempt: currentRepair.attempt };
    }
    currentRepair.approved = true;
    this.updateTaskState(task, TaskState.APPLYING_REPAIR, `Applying fix for repair attempt ${currentRepair.attempt}.`);
    return { ok: true, approved: true, status: 'approved', attempt: currentRepair.attempt };
  }

  completeRepairAttempt(task, result = {}) {
    if (!task) return { ok: false, error: 'There is no active task.' };
    const currentRepair = task.context.currentRepair ?? { attempt: task.context.repairAttempt ?? 0, failure: {} };
    currentRepair.completed = true;
    currentRepair.result = { ...result, attempt: currentRepair.attempt };
    task.context.verificationResults.push({ ...currentRepair.result, repairAttempt: currentRepair.attempt });
    task.context.finalResult = currentRepair.result;
    const status = String(result.status ?? (result.exitCode === 0 ? 'PASSED' : 'FAILED'));
    if (status === 'PASSED') {
      this.updateTaskState(task, TaskState.COMPLETED, 'Repair verified successfully.');
      return { ok: true, status, attempt: currentRepair.attempt, ...currentRepair.result };
    }
    if (currentRepair.attempt >= this.maxRepairAttempts) {
      this.updateTaskState(task, TaskState.REPAIR_LIMIT_REACHED, `Maximum repair attempts reached (${this.maxRepairAttempts}).`);
      return { ok: true, status, attempt: currentRepair.attempt, limitReached: true, ...currentRepair.result };
    }
    this.updateTaskState(task, TaskState.ANALYZING_FAILURE, `Repair attempt ${currentRepair.attempt} failed; preparing the next repair cycle.`);
    return { ok: true, status, attempt: currentRepair.attempt, limitReached: false, ...currentRepair.result };
  }

  async completeTask(task, result) {
    if (!task) return null;
    task.context.finalResult = result;
    task.updatedAt = new Date().toISOString();
    this.updateTaskState(task, TaskState.COMPLETED, 'Task completed.');
    return task;
  }

  async failTask(task, error) {
    if (!task) return null;
    task.context.errors.push(String(error ?? 'Task failed.'));
    task.updatedAt = new Date().toISOString();
    this.updateTaskState(task, TaskState.FAILED, 'Task failed and requires user action.');
    return task;
  }

  cancelTask(task, reason = 'Task cancelled by the user.') {
    if (!task) return null;
    task.context.notes.push(String(reason));
    task.updatedAt = new Date().toISOString();
    this.updateTaskState(task, TaskState.CANCELLED, reason);
    return task;
  }
}
