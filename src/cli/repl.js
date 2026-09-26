import { createInterface } from 'node:readline';
import { formatProjectSummary } from '../core/project-inspector.js';
import { formatGitStatus, formatGitLog } from '../core/git-service.js';
import { ProviderError } from '../models/provider.js';

const EXIT_COMMANDS = new Set(['exit', 'quit']);
const NETWORK_ERROR = 'Forge could not reach the AI provider. Check your internet connection and try again.';
const PROVIDER_ERROR = 'Forge received an error from the AI provider.';

function renderCommandResult(result) {
  const output = [];
  if (result.stdout?.trim()) output.push(`stdout:\n${result.stdout.trimEnd()}`);
  if (result.stderr?.trim()) output.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.verificationSummary) {
    return [
      `Forge:\n${result.summary}`,
      result.verificationSummary,
      result.repairPreview,
      result.repairLimitReached ? `Repair limit reached (${result.maxRepairAttempts ?? 'configured maximum'}). No further repair was proposed.` : null,
      result.repairError ? `Repair was not prepared: ${result.repairError}` : null,
      ...output
    ].filter(Boolean).join('\n\n');
  }
  const status = result.timedOut
    ? `Timed out after ${result.durationMs} ms.`
    : result.exitCode === null
      ? 'The command could not be started.'
      : `Exit code: ${result.exitCode} (${result.durationMs} ms).`;
  return [`Forge:\n${result.summary}`, status, ...output].join('\n\n');
}

function formatProviderName(providerName) {
  if (!providerName || typeof providerName !== 'string') return 'OpenAI';
  return providerName.toLowerCase() === 'local' ? 'Local' : 'OpenAI';
}

export async function runRepl({ input = process.stdin, output = process.stdout, conversation, model = 'unknown', providerName = 'unknown', project, debug = false }) {
  const displayProvider = formatProviderName(providerName);
  output.write(`\nForge\nOpen-source AI coding agent\nModel: ${model} (${displayProvider})\nWorkspace: ${project?.displayPath ?? 'Unknown'}\nType your request below. Type exit or quit to leave. Enter /project for a project summary. Enter /model to show the active provider and model.\n`);
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY)
  });
  let interrupted = false;
  let goodbyePrinted = false;
  let protectedApprovalArmed = null;

  readline.on('SIGINT', () => {
    interrupted = true;
    output.write('\nGoodbye.\n');
    readline.close();
  });
  readline.setPrompt('\n> ');
  readline.prompt();

  try {
    for await (const line of readline) {
      const prompt = line.trim();
      if (conversation.pendingCommandPlan) {
        if (['n', 'no', 'cancel'].includes(prompt.toLowerCase())) {
          const result = await conversation.rejectPendingCommand();
          output.write(result.previouslyRun
            ? '\nRemaining commands cancelled. Previously approved commands have already run.\n'
            : '\nCommand plan rejected. No commands were run.\n');
          if (!readline.closed) readline.prompt();
          continue;
        }
        if (EXIT_COMMANDS.has(prompt.toLowerCase())) {
          const result = await conversation.rejectPendingCommand();
          output.write(result.previouslyRun
            ? '\nRemaining commands cancelled. Goodbye.\n'
            : '\nCommand plan cancelled. Goodbye.\n');
          goodbyePrinted = true;
          return;
        }
        if (['y', 'yes'].includes(prompt.toLowerCase())) {
          const command = conversation.pendingCommandPlan.commands[conversation.pendingCommandPlan.index];
          output.write(`\nRunning ${command.command}...\n`);
          const result = await conversation.approvePendingCommand();
          if (!result.ok) {
            output.write(`\nCommand was not run: ${result.error}\n`);
          } else {
            output.write(`\n${renderCommandResult({
              ...result.commandResult,
              summary: result.summary,
              verificationSummary: result.verificationSummary,
              repairPreview: result.repairPreview,
              repairError: result.repairError,
              repairLimitReached: result.repairLimitReached,
              maxRepairAttempts: result.maxRepairAttempts
            })}\n`);
            if (!result.complete) {
              output.write(`\nForge wants to run next:\n${result.nextCommand}\nAllow this command? [y/N]\n`);
            }
          }
          if (!readline.closed) readline.prompt();
          continue;
        }
        output.write('\nEnter y to run this command, n to reject remaining commands, or exit to leave.\n');
        if (!readline.closed) readline.prompt();
        continue;
      }
      if (conversation.pendingChangeProposal) {
        if (['n', 'no', 'cancel'].includes(prompt.toLowerCase())) {
          const result = await conversation.rejectPendingChange();
          protectedApprovalArmed = null;
          output.write(result.repair
            ? '\nRepair proposal rejected. No repair changes were applied; earlier approved changes remain.\n'
            : '\nChanges rejected. No files were modified.\n');
          if (!readline.closed) readline.prompt();
          continue;
        }
        if (EXIT_COMMANDS.has(prompt.toLowerCase())) {
          await conversation.rejectPendingChange();
          protectedApprovalArmed = null;
          output.write('\nPending changes cancelled. Goodbye.\n');
          goodbyePrinted = true;
          return;
        }

        const proposal = conversation.pendingChangeProposal;
        if (proposal.requiresProtectedConfirmation) {
          if (prompt === 'CONFIRM PROTECTED') {
            if (protectedApprovalArmed !== proposal.id) {
              output.write('\nApprove with y first, then type CONFIRM PROTECTED to continue.\n');
              if (!readline.closed) readline.prompt();
              continue;
            }
            const result = await conversation.approvePendingChange({ protectedConfirmation: true });
            protectedApprovalArmed = null;
            output.write(result.ok
              ? `\nChanges applied successfully.\n${result.changed.map((change) => `${change.action}: ${change.path}`).join('\n')}\n`
              : `\nChanges were not applied: ${result.error}\n`);
            if (!readline.closed) readline.prompt();
            continue;
          }
          if (['y', 'yes', 'a'].includes(prompt.toLowerCase())) {
            protectedApprovalArmed = proposal.id;
            output.write('\nProtected-file warning: type CONFIRM PROTECTED exactly to continue, or n to cancel.\n');
            if (!readline.closed) readline.prompt();
            continue;
          }
          output.write('\nType y to approve this proposal, n to reject it, or exit to leave.\n');
          if (!readline.closed) readline.prompt();
          continue;
        }

        if (['y', 'yes', 'a'].includes(prompt.toLowerCase())) {
          const result = await conversation.approvePendingChange();
          output.write(result.ok
            ? `\nChanges applied successfully.\n${result.changed.map((change) => `${change.action}: ${change.path}`).join('\n')}${result.verificationPlan ? `\n\n${result.verificationPlan}` : ''}${result.verificationSummary ? `\n\n${result.verificationSummary}` : ''}${result.verificationError ? `\n\nVerification could not be prepared: ${result.verificationError}` : ''}\n`
            : `\nChanges were not applied: ${result.error}\n`);
        } else {
          output.write('\nEnter y to apply this complete change set, n to reject, or exit to leave.\n');
        }
        if (!readline.closed) readline.prompt();
        continue;
      }
      if (EXIT_COMMANDS.has(prompt.toLowerCase())) {
        output.write('Goodbye.\n');
        goodbyePrinted = true;
        return;
      }
      if (prompt.toLowerCase() === '/project') {
        output.write(`\n${project ? formatProjectSummary(project) : 'Project inspection is unavailable.'}\n`);
        if (!readline.closed) {
          readline.prompt();
        }
        continue;
      }
      if (prompt.toLowerCase() === '/model') {
        const label = formatProviderName(providerName);
        output.write(`\nCurrent provider: ${label}\nCurrent model: ${model}\nAvailable configured models: ${model}\n`);
        if (!readline.closed) readline.prompt();
        continue;
      }
      if (prompt.toLowerCase() === '/git' || prompt.toLowerCase().startsWith('/git ')) {
        const gitCommand = prompt.toLowerCase().startsWith('/git ') ? prompt.slice(5).trim() : 'status';
        if (!conversation.gitService) {
          output.write('\nGit service is unavailable in this workspace.\n');
          if (!readline.closed) readline.prompt();
          continue;
        }
        const status = await conversation.gitService.status();
        if (gitCommand === 'status') {
          output.write(`\n${formatGitStatus(status)}\n`);
        } else if (gitCommand === 'diff') {
          const diff = await conversation.gitService.diff({});
          output.write(`\n${diff.ok ? diff.text : diff.error}\n`);
        } else if (gitCommand === 'log') {
          const log = await conversation.gitService.log({ limit: 10 });
          output.write(`\n${formatGitLog(log)}\n`);
        } else {
          output.write('\nSupported /git commands: /git status, /git diff, /git log\n');
        }
        if (!readline.closed) readline.prompt();
        continue;
      }
      if (!prompt) {
        if (!readline.closed) {
          readline.prompt();
        }
        continue;
      }

      try {
        output.write('\nThinking...\n');
        const answer = await conversation.ask(prompt);
        if (interrupted) continue;
        output.write(`\nForge:\n${answer}\n`);
      } catch (error) {
        if (interrupted) continue;
        const message = debug && error instanceof Error
          ? error.message
          : error instanceof ProviderError && error.kind === 'network'
            ? NETWORK_ERROR
            : PROVIDER_ERROR;
        output.write(`\n${message}\n`);
      }
      if (!readline.closed) {
        readline.prompt();
      }
    }
  } finally {
    readline.close();
    if (!interrupted && !goodbyePrinted) {
      output.write('\nGoodbye.\n');
    }
  }
}
