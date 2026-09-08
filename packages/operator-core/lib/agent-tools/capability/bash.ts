/**
 * capability:bash — run a shell command. A THIN wrapper over a real `bash -c`
 * (D-004 — wraps real execution, no reimplementation), routed through the
 * shared endpoint dispatch so policy / capability-envelope / telemetry apply
 * (P-010, `agent-capability-confinement-2026-06-13`). It replicates the native
 * Bash tool's ergonomics: combined output streaming (the `output` event),
 * truncation/overflow-to-file, and async/background jobs (`run_in_background`).
 *
 * Foreground: streams output, enforces a short wall-clock timeout, returns the
 * (head+tail-trimmed-if-large) combined output + the spill-log path.
 * Background: returns a `bash_id` and durable `task_id` immediately; read
 * incremental output with `capability:bash_output` and stop it with
 * `capability:bash_kill` — the way a 5-minute build is run without holding one
 * blocking request. The task id remains observable through the task ledger if
 * the operator restarts and its in-memory bash-job map is lost.
 *
 * BOTH modes have a deadline; they do NOT share one (WI-6677). The background
 * default is hours, not the foreground's two minutes, because a background job
 * is by definition meant to outlive the call — see the constants in
 * `bash-jobs.ts` for why inheriting the foreground pair was a trap.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  CAPABILITY_BASH_FOREGROUND_ENV,
  CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detectBufferingLastStage,
  detectSelfOutputRedirect,
  detectUntrackedShellBackgrounding,
  formatBufferingPipelineAdvice,
  formatSelfRedirectAdvice,
  formatUntrackedShellBackgroundAdvice,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
} from './foreground-transport-cap';
import { typecheckHeapLaunchWarning } from './background-typecheck-verdict';
import { similarity } from '../../operator-fuzzy-dedup';
import { capabilityExecSandboxPolicy } from './exec-sandbox';
import { displayForHive } from '../computer/desktop-lease';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { realpathSoft, resolveCapabilityBaseDir } from './base-dir';
import { maskIntegrationKey, readIntegrationKey } from '../../integration-credentials';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveOwnerGoal } from '../coordination/agent-goal-sources';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { readHeldWorkItems } from '../../carry-brief';
import { listLiveTasks } from '../../task-manager/store';
import {
  classifyFrozenLineageShellCommand,
  evaluateFrozenLineageShellCommand,
  frozenLineageShellCommandViolationPayload,
} from '../../release/frozen-lineage-execution-policy';
import { repoHeadSha } from '../../harness/docs/git-runner';
import { resolveCapabilityIntegrationRoot } from './base-dir';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTEGRATION_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_INTEGRATION_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
]);

const MIN_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_ERROR =
  `timeout must be at least ${MIN_TIMEOUT_MS}ms (1 second); timeout is expressed in milliseconds — ` +
  `for 20 seconds, pass 20000`;

type BashEffect = 'read' | 'write';

/**
 * Split the small shell language we are willing to classify. This is deliberately
 * not a shell parser: anything that could hide another command or redirect output
 * is rejected so the caller keeps capability:bash's normal write classification.
 */
function splitClassifiableShell(command: string): string[][] | null {
  if (!command.trim() || command.includes('\0')) return null;

  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    if (word) {
      words.push(word);
      word = '';
    }
  };
  const flushSegment = (): boolean => {
    flushWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      // A double-quoted expansion can execute a hidden command or select an
      // argument we cannot inspect. Backslash escapes are safe only for ordinary
      // characters; shell metacharacters stay conservative.
      if (char === '$' || char === '`') return null;
      if (char === '\\') {
        const next = command[i + 1];
        if (next === undefined || /[;&|<>`()$`]/.test(next)) return null;
        word += next;
        i += 1;
        continue;
      }
      word += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (next === undefined || /[;&|<>`()$`]/.test(next)) return null;
      word += next;
      i += 1;
      continue;
    }
    if (char === '`' || char === '$') return null;
    if (char === '<' || char === '>') return null; // redirection / process substitution
    if (char === '&') {
      if (command[i + 1] !== '&') return null; // backgrounding is never observational
      if (!flushSegment()) return null;
      i += 1;
      continue;
    }
    if (char === '|') {
      if (command[i + 1] === '&') return null; // stderr pipe hides the shell boundary
      if (!flushSegment()) return null;
      if (command[i + 1] === '|') i += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      if (!flushSegment()) return null;
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (char === '(' || char === ')' || char === '{' || char === '}') return null;
    word += char;
  }

  if (quote !== null || !flushSegment()) return null;
  return segments;
}

function commandBase(command: string): string {
  const slash = command.lastIndexOf('/');
  return (slash >= 0 ? command.slice(slash + 1) : command).toLowerCase();
}

const READ_ONLY_COMMANDS = new Set([
  '[',
  'basename',
  'cat',
  'column',
  'cut',
  'date',
  'df',
  'dirname',
  'dmesg',
  'du',
  'echo',
  'file',
  'free',
  'fuser',
  'getconf',
  'groups',
  'head',
  'hostname',
  'id',
  'iostat',
  'journalctl',
  'ls',
  'lsof',
  'mpstat',
  'netstat',
  'pgrep',
  'pidof',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'sed',
  'sleep',
  'sort',
  'ss',
  'stat',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'uname',
  'uniq',
  'uptime',
  'vmstat',
  'wc',
  'whereis',
  'which',
  'whoami',
]);

const READ_ONLY_SYSTEMCTL_COMMANDS = new Set([
  'cat',
  'help',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-dependencies',
  'list-unit-files',
  'list-units',
  'show',
  'status',
  '--version',
]);

const READ_ONLY_IP_COMMANDS = new Set(['address', 'addr', 'link', 'neigh', 'neighbor', 'route', 'rule']);
const SHELL_MUTATION_WORDS = new Set([
  'add',
  'append',
  'change',
  'clear',
  'del',
  'delete',
  'flush',
  'kill',
  'replace',
  'restart',
  'rm',
  'set',
  'start',
  'stop',
]);

function hasOption(tokens: readonly string[], options: readonly string[]): boolean {
  return tokens.some((token) => options.some((option) => token === option || token.startsWith(`${option}=`)));
}

function firstNonOption(tokens: readonly string[], start = 1): string | undefined {
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i] === '--') return tokens[i + 1];
    if (!tokens[i]!.startsWith('-')) return tokens[i];
  }
  return undefined;
}

function classifiesSystemctlRead(tokens: readonly string[]): boolean {
  if (tokens.some((token) => token.toLowerCase() === '--version')) return true;
  const subcommand = firstNonOption(tokens);
  return subcommand !== undefined && READ_ONLY_SYSTEMCTL_COMMANDS.has(subcommand.toLowerCase());
}

function classifiesIpRead(tokens: readonly string[]): boolean {
  const subcommand = firstNonOption(tokens)?.toLowerCase();
  if (!subcommand || !READ_ONLY_IP_COMMANDS.has(subcommand)) return false;
  return !tokens.slice(1).some((token) => SHELL_MUTATION_WORDS.has(token.toLowerCase()));
}

function classifiesGitRead(tokens: readonly string[]): boolean {
  const dangerousFlags = [
    '-c',
    '-C',
    '-d',
    '-D',
    '-f',
    '-m',
    '-M',
    '--copy',
    '--delete',
    '--edit-description',
    '--exec-path',
    '--move',
  ];
  if (hasOption(tokens, dangerousFlags) || hasOption(tokens, ['-o', '--output'])) return false;
  const subcommand = firstNonOption(tokens)?.toLowerCase();
  if (!subcommand) return false;
  if (subcommand === 'branch') {
    // `git branch <name>` creates a branch; only option-only inspection forms
    // are safe here. Listing a named branch is intentionally left write-classed
    // rather than trying to model every git option combination.
    return !tokens.slice(2).some((token) => !token.startsWith('-'));
  }
  if (subcommand === 'remote') {
    const nested = firstNonOption(tokens, 2)?.toLowerCase();
    return nested === undefined || nested === 'get-url' || nested === 'get-branches' || nested === 'show';
  }
  return new Set([
    'branch',
    'cat-file',
    'describe',
    'diff',
    'log',
    'ls-files',
    'ls-tree',
    'rev-parse',
    'show',
    'shortlog',
    'status',
  ]).has(subcommand);
}

function classifiesStraceRead(tokens: readonly string[]): boolean {
  if (
    hasOption(tokens, ['-o', '--output', '--kill-on-exit']) ||
    tokens.some((token) => /(?:inject|fault|signal|syscall|daemon|detach-on|kill)/i.test(token))
  ) {
    return false;
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if ((token === '-p' || token === '--attach' || token === '--attach-pid') && /^\d+$/.test(tokens[i + 1] ?? '')) {
      return true;
    }
    if (/^-p\d+$/.test(token) || /^--attach(?:-pid)?=\d+$/.test(token)) return true;
  }
  return false;
}

function classifiesSimpleRead(tokens: readonly string[], depth = 0): boolean {
  if (depth > 2 || tokens.length === 0) return false;
  const base = commandBase(tokens[0]!);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return false;

  if (base === 'timeout') {
    let durationIndex = 1;
    while (durationIndex < tokens.length && tokens[durationIndex]!.startsWith('-')) {
      durationIndex += tokens[durationIndex] === '-k' ? 2 : 1;
    }
    if (durationIndex >= tokens.length || !/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[durationIndex]!)) {
      return false;
    }
    return classifiesSimpleRead(tokens.slice(durationIndex + 1), depth + 1);
  }
  if (base === 'systemctl') return classifiesSystemctlRead(tokens);
  if (base === 'ip') return classifiesIpRead(tokens);
  if (base === 'git') return classifiesGitRead(tokens);
  if (base === 'strace') return classifiesStraceRead(tokens);
  if (base === 'command') return tokens.length === 3 && (tokens[1] === '-v' || tokens[1] === '-V');
  if (base === 'docker') {
    return new Set(['info', 'inspect', 'ps', 'stats', 'version']).has(firstNonOption(tokens)?.toLowerCase() ?? '');
  }
  if (!READ_ONLY_COMMANDS.has(base)) return false;
  if (base === 'dmesg' && hasOption(tokens, ['--clear', '-C'])) return false;
  if (base === 'date' && hasOption(tokens, ['-s', '--set'])) return false;
  if (base === 'fuser' && hasOption(tokens, ['-k', '--kill'])) return false;
  if (base === 'journalctl' && tokens.some((token) => /^--(?:flush|relinquish-var|rotate|sync|vacuum)/.test(token))) {
    return false;
  }
  if (base === 'rg' && hasOption(tokens, ['--pre'])) return false;
  if (base === 'sed' && hasOption(tokens, ['-i', '--in-place'])) return false;
  if (base === 'ss' && hasOption(tokens, ['-K', '--kill'])) return false;
  if (base === 'sort' && hasOption(tokens, ['-o', '--output'])) return false;
  return true;
}

/**
 * Resolve capability:bash's effect for one call. The tool's capability remains a
 * write-capability, but a shell is a read only when every command segment is a
 * recognized observation and the shell has no hidden execution or redirection.
 * Unknown syntax intentionally falls back to write for dry-run safety.
 */
export function classifyCapabilityBashEffect(args: unknown): BashEffect {
  if (!args || typeof args !== 'object') return 'write';
  const record = args as { command?: unknown; cmd?: unknown };
  const command = typeof record.command === 'string' ? record.command : record.cmd;
  if (typeof command !== 'string') return 'write';
  const segments = splitClassifiableShell(command);
  return segments && segments.every((segment) => classifiesSimpleRead(segment)) ? 'read' : 'write';
}

/**
 * A stale harness registry can leave `ctx.projectDir` pointing at a directory
 * that no longer exists. `resolveCapabilityBaseDir` intentionally preserves
 * that path for the read/write/edit capability family, where changing the
 * shared resolver would alter their path semantics. Bash is different: its
 * child process cannot start with a missing cwd. For an implicit cwd only,
 * recover to the operator's existing integration root when one is available.
 * Explicit cwd arguments never pass through this recovery path.
 */
export function resolveBashDefaultCwd(baseDir: string): string {
  try {
    if (statSync(baseDir).isDirectory()) return baseDir;
  } catch {
    // Fall through to the integration-root recovery check.
  }

  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!integrationRoot) return baseDir;

  try {
    if (!statSync(integrationRoot).isDirectory()) return baseDir;
  } catch {
    return baseDir;
  }

  // Keep the same real-path guarantee as resolveCapabilityBaseDir so the
  // exec-sandbox's writable cwd bind follows writes through symlinks.
  return realpathSoft(integrationRoot);
}

/** A near-match is a real repair candidate only above this — below it, two unrelated
 * short directory names can coincidentally score high, and a wrong guess is worse than
 * none (EI-21859036061097062: `evidence` vs `essence` scores 0.7 by raw Levenshtein). */
const CWD_SUGGESTION_SIMILARITY_FLOOR = 0.82;

/**
 * EI-21859036061097062: an explicit cwd whose failing SEGMENT is a near-miss rename of
 * a real sibling directory (measured: `papercuspai-workspace` for the long-lived
 * `papercupai-workspace` — an easy transposition once the harness itself is named
 * `papercusp`) fails with nothing to correct FROM. Walk up to the nearest existing
 * ancestor, and if EXACTLY ONE of its siblings is a close-enough rename of the missing
 * segment, reconstruct the corrected full path and verify it actually resolves before
 * suggesting it — this must never offer a guess that is itself still broken, and an
 * ambiguous (0 or 2+) match says nothing rather than pick one.
 */
export function suggestExistingCwd(cwd: string): string | undefined {
  // `probe` walks UP from `cwd` looking for the nearest existing ancestor; `cwd` itself
  // stays untouched so the remainder below is computed against the FULL original path,
  // not just the (possibly much shallower) non-existent prefix the walk stopped at.
  let probe = cwd;
  let ancestor = dirname(probe);
  // Walk up until an existing directory is found, or we hit the filesystem root
  // (dirname('/') === '/', which is the loop's only termination without a match).
  while (ancestor !== probe) {
    try {
      if (statSync(ancestor).isDirectory()) break;
    } catch {
      // Not this one either — keep walking up.
    }
    probe = ancestor;
    ancestor = dirname(probe);
  }
  if (ancestor === probe) return undefined; // no existing ancestor at all

  const remainder = cwd.slice(ancestor.length).replace(/^[/\\]+/, '');
  const missingSegment = remainder.split(/[/\\]/)[0];
  if (!missingSegment) return undefined;
  const rest = remainder.slice(missingSegment.length);

  let siblings: string[];
  try {
    siblings = readdirSync(ancestor);
  } catch {
    return undefined;
  }

  const candidates = siblings
    .filter((entry) => entry !== missingSegment)
    .map((entry) => ({ entry, score: similarity(entry, missingSegment) }))
    .filter(({ score }) => score >= CWD_SUGGESTION_SIMILARITY_FLOOR);
  if (candidates.length !== 1) return undefined; // no match, or too ambiguous to guess

  const rebuilt = join(ancestor, candidates[0]!.entry) + rest;
  try {
    if (statSync(rebuilt).isDirectory()) return rebuilt;
  } catch {
    // The reconstructed path doesn't check out either — say nothing rather than
    // suggest a path that is itself still broken.
  }
  return undefined;
}

/**
 * Node reports a nonexistent child cwd as an ENOENT on the BINARY
 * (`spawn /usr/bin/bash ENOENT`), which reads as "bash is missing" and has
 * been misdiagnosed that way (EI-21357058090189702, via code:run on a harness
 * whose registered repo root does not exist). Check the final cwd before any
 * spawn and fail with the real cause and the concrete fix instead.
 */
export function missingBashCwdError(cwd: string, explicitCwd: boolean): string | null {
  try {
    if (statSync(cwd).isDirectory()) return null;
    return (
      `capability:bash cwd '${cwd}' exists but is not a directory — the child process cannot start there. ` +
      `Pass an existing directory as cwd.`
    );
  } catch {
    // Missing (or unreadable) — fall through to the explanatory error below.
  }
  if (explicitCwd) {
    const suggestion = suggestExistingCwd(cwd);
    return (
      `capability:bash cwd '${cwd}' does not exist — the child process cannot start. ` +
      `(Node would report this as a misleading "spawn /usr/bin/bash ENOENT".) ` +
      (suggestion ? `Did you mean '${suggestion}'? ` : '') +
      `Pass an existing directory as cwd.`
    );
  }
  return (
    `capability:bash implicit cwd '${cwd}' (this context's project dir) does not exist, and no existing ` +
    `PAPERCUSP_INTEGRATION_ROOT was available to recover to — the harness registry likely points at a ` +
    `stale or phantom repo root. Pass cwd explicitly (an absolute path to an existing directory). ` +
    `(Node would otherwise report this as a misleading "spawn /usr/bin/bash ENOENT".)`
  );
}

export interface BashTaskProvenance {
  launchedBy: string;
  sessionId: string | null;
  harnessSlug: string | null;
  workItemId: string | null;
  planSlug: string | null;
  goalRef: string | null;
}

interface BashTaskProvenanceDeps {
  resolveIdentity: typeof resolveAgentIdentity;
  readStamp: typeof readAgentStateStamp;
  resolveGoal: typeof resolveOwnerGoal;
  /**
   * EI-21548894457555139: the caller's held (assigned, non-terminal) work-items, used
   * ONLY as the fallback below when the goal ref is not itself a work-item id. Reuses
   * the same reader the carry brief and orient's recovery fold use, so the three
   * surfaces cannot disagree about what an agent holds.
   */
  readHeldWorkItems: typeof readHeldWorkItems;
}

const DEFAULT_BASH_PROVENANCE_DEPS: BashTaskProvenanceDeps = {
  resolveIdentity: resolveAgentIdentity,
  readStamp: readAgentStateStamp,
  resolveGoal: resolveOwnerGoal,
  readHeldWorkItems,
};

/**
 * Resolve background-task provenance at the launch seam, while the caller's
 * stable identity and live goal are still available.  The task ledger cannot
 * reconstruct either from a child pid later.  Resolution is fail-soft: an
 * unattributable caller still gets a working shell, but never a fabricated
 * work-item association.
 */
export async function resolveBashTaskProvenance(
  ctx: ResolveIdentityCtx,
  harnessSlug: string | null,
  deps: BashTaskProvenanceDeps = DEFAULT_BASH_PROVENANCE_DEPS,
): Promise<BashTaskProvenance> {
  let ownerId: string | null = null;
  try {
    ownerId = deps.resolveIdentity(ctx).ownerId;
  } catch {
    ownerId = null;
  }

  let goalRef = ownerId ? deps.readStamp(ownerId).goalRef : null;
  if (ownerId && !goalRef) {
    goalRef = (await deps.resolveGoal(ownerId, 'self'))?.ref ?? null;
  }

  let workItemId = goalRef && /^(?:WI|EI|F)-[A-Za-z0-9._-]+$/.test(goalRef) ? goalRef : null;
  // EI-21548894457555139: the goal ref is only SOMETIMES a work-item id. A fleet leader
  // or a plan-bound agent declares `fleet:<slug>` / `<plan>#P-NNN`, so the regex above
  // yields null and the task lands in the ledger unlinked — `processes:list` then cannot
  // answer "which work-item is this process for?" even though the agent is holding one.
  // Measured: an agent holding EI-21548894457555139 linked correctly, while the same
  // agent's fleet-scoped work would not have.
  //
  // Fall back to the caller's held claim, and ONLY when it is UNAMBIGUOUS. An agent
  // holding several items gives no basis for choosing between them, and a fabricated
  // work-item association is worse than an absent one: absent reads as "unknown", while
  // wrong reads as fact and misattributes the cost and the provenance of the run. That
  // is the same principle this function's own doc comment already states.
  if (!workItemId && ownerId) {
    try {
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? '';
      const held = await deps.readHeldWorkItems(ownerId, workspaceId, { limit: 2 });
      if (held.length === 1) workItemId = held[0].id;
    } catch {
      // Provenance is fail-soft by contract — an unreadable claim never blocks the shell.
    }
  }
  const planMatch = goalRef?.match(/^(?:plan:)?(.+?)#P-\d+$/) ?? null;
  const principalFallback = ctx.principal?.slug?.trim() || 'capability:bash';
  return {
    launchedBy: ownerId ?? principalFallback,
    sessionId: ownerId,
    harnessSlug,
    workItemId,
    planSlug: planMatch?.[1] ?? null,
    goalRef,
  };
}

const integrationEnvSchema = z
  .record(
    z.string().regex(ENV_NAME_RE, 'destination must be a valid environment variable name'),
    z.string().regex(INTEGRATION_KEY_NAME_RE, 'source must be a SCREAMING_SNAKE_CASE integration credential name'),
  )
  .refine((value) => Object.keys(value).length <= 16, 'integration_env accepts at most 16 entries')
  .refine(
    (value) => Object.keys(value).every((name) => !RESERVED_INTEGRATION_ENV_NAMES.has(name)),
    `integration_env cannot replace reserved process variables: ${[...RESERVED_INTEGRATION_ENV_NAMES].join(', ')}`,
  );

export default defineTool({
  name: 'capability:bash',
  description:
    'Run `bash -c` in the project dir; stream and spill large output to a log. Operator callers may bind redacted integration credentials.',
  guidance: {
    // WI-71582: the `jq` tip below was CUT FROM THE PROMPT to clear the 1500-char
    // prompt-weight HARD CAP (this tool was 1613 — a gate RED). Kept here because a
    // comment costs ZERO prompt weight (promptWeight() sums description + when +
    // notWhen + chaining + byRole only, per the note at :247), so the knowledge is
    // preserved without the budget cost — do NOT paste it back into `when`:
    //   "For non-trivial `jq` filters, compile first with `jq -n` against no input
    //    before reading exports; this catches syntax errors without consuming export
    //    input."
    // It was the narrowest tip here (it helps only a non-trivial jq filter over a
    // consumable export), which is why it lost to the rg/backtick and background-job
    // guidance. If it needs to be agent-facing again, put it in a doc and point at it.
    when:
      'Run builds/tests/checks/scripts. For fixed-string searches prefer `rg -F`, else `grep -F`; single-quote the argument — an unmatched backtick fails before either tool runs. ' +
      `${RIPGREP_SCOPE_GUIDANCE} Do not run an unbounded search from the repository root. For jobs over 1–2 minutes use run_in_background:true → capability:bash_output; do not shell-background child with \`&\`/nohup/setsid/disown without \`wait\`; 4h/12h defaults.`,
    notWhen:
      'Use capability:read/write/edit for one-file ops and capability:git for git. Shell execution strips DB credential env vars, so use dev:pg_query for read-only operator DB queries.',
    chaining:
      'run_in_background:true returns bash_id + durable task_id → capability:bash_output { task_id }; stop with processes:kill { taskId }. Never push.',
    // EI-21543657511391052: the stale 'capability:bash_kill' entry is DELETED, not
    // replaced. It is absent from trimmed surfaces (su) and refuses some principals, so
    // it routed callers to a verb they could not invoke. No substitute is needed here
    // because `chaining` above already names the working route (processes:kill{taskId}).
    // NOTE for whoever edits this next: `seeAlso` is NOT summed by promptWeight()
    // (tool-guidance-budget.ts — description + when + notWhen + chaining + byRole only),
    // so changing this array cannot move the prompt-weight budget in either direction.
    seeAlso: [
      'capability:bash_output (read a backgrounded run)',
      'capability:git (git actions, gated as git)',
    ],
  },
  capability: 'capability:bash',
  effectForCall: classifyCapabilityBashEffect,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Wall-clock dispatch timeout must exceed the max command timeout so a long
  // foreground command can complete (background mode is preferred for those).
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
  // EI-18666279107998059: this handler awaits a child process for up to
  // MAX_TIMEOUT_MS (minutes) and never reads ctx.tx — without this, the host's
  // ambient workspace transaction sits idle for the whole exec and gets killed
  // by Postgres's idle_in_transaction_session_timeout (60s), surfacing as a
  // bare "write CONNECTION_CLOSED 127.0.0.1:6432" that correlates with call
  // duration, not the command. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  events: { output: z.string().describe('text/plain') },
  args: z.object({
    command: z
      .string()
      .min(1)
      .optional()
      .describe('The bash command to run (passed to `bash -c`). Required, unless `cmd` is given.'),
    cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Alias for `command`. Accepted because the Codex CLI\'s own native `shell` tool call uses "cmd" as its ' +
          'argument key (EI-22073622160284651: a Codex-backed agent reaching for this tool by habit typed `cmd` ' +
          'and was rejected), so an agent used to that convention can reach for it here too. Prefer `command`.',
      ),
    description: z
      .string()
      .optional()
      .describe('5–10 word description of what the command does (for telemetry / the agent log).'),
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS, MIN_TIMEOUT_ERROR)
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms (minimum ${MIN_TIMEOUT_MS}; values below one second are rejected to catch ` +
          `seconds-vs-milliseconds mistakes — 20 seconds = 20000ms). FOREGROUND: default ${DEFAULT_TIMEOUT_MS}, CLAMPED to ${FOREGROUND_TIMEOUT_CEILING_MS} — ` +
          `below the ~55s MCP transport cap, so a slow command returns an actionable timeout instead of an opaque ` +
          `transport failure. Raising it past the clamp does nothing: run anything longer with run_in_background. ` +
          `BACKGROUND (run_in_background): default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS} — ` +
          `not bound by the transport cap, but the whole confined task subtree IS terminated at its own deadline ` +
          `(systemd RuntimeMaxSec plus the local SIGTERM/SIGKILL path), ` +
          `so raise this for a job that legitimately runs longer. Deliberately daemonized descendants remain tracked ` +
          `inside the same task and share its deadline; use a dedicated service launcher for a different lifetime.`,
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Run detached; returns a bash_id immediately. Read output via capability:bash_output.'),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        'Allow a duplicate background launch when a live task already has the exact same command and cwd. ' +
          'Use only when the duplicate is intentional.',
      ),
    cwd: z
      .string()
      .optional()
      .describe('Working dir (absolute, or relative to the project dir). Defaults to the project dir.'),
    integration_env: integrationEnvSchema
      .optional()
      .describe(
        'Operator-authority only. Map child environment variable names to encrypted setup:save_integration_key names, e.g. {"DEEPGRAM_API_KEY":"SIDESTAGE_DEEPGRAM_API_KEY"}. Raw values stay server-side, exist only in this child process, and are exact-value-redacted from events, results, background reads, and spill logs.',
      ),
  }),
  async handler(args, ctx) {
    // command/cmd: `cmd` is accepted as an alias (see its schema description) — normalize to
    // one local binding so every downstream use is unambiguous and `command` stays required
    // in effect even though the schema field itself is optional to make room for the alias.
    const command = args.command ?? args.cmd;
    if (!command) {
      throw new Error(
        'command is required (the bash command to run, passed to `bash -c`); `cmd` is also accepted as an alias',
      );
    }
    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd
      ? isAbsolute(args.cwd)
        ? args.cwd
        : resolve(baseDir, args.cwd)
      : resolveBashDefaultCwd(baseDir);
    // Preflight the FINAL cwd (explicit or recovered-implicit) before either
    // spawn path, so a missing directory fails with its real cause instead of
    // the child's misleading `spawn /usr/bin/bash ENOENT`.
    const cwdError = missingBashCwdError(cwd, Boolean(args.cwd));
    if (cwdError) throw new Error(cwdError);
    // Classify before any Git read. The overwhelmingly common command remains a
    // pure string check; only a canonical root test or candidate worktree cut
    // reaches the live marker/HEAD CAS immediately before its actual spawn.
    const frozenLineageRoot = resolveCapabilityIntegrationRoot();
    const frozenLineageCommand = frozenLineageRoot
      ? classifyFrozenLineageShellCommand({ command, cwd: realpathSoft(cwd) })
      : null;
    const frozenLineageRefusal = async () => {
      if (!frozenLineageRoot) return null;
      const verdict = await evaluateFrozenLineageShellCommand(frozenLineageCommand, frozenLineageRoot, {
        readCheckoutHead: repoHeadSha,
        canonicalizePath: realpathSoft,
      });
      return frozenLineageShellCommandViolationPayload(verdict);
    };
    if (args.run_in_background) {
      const untrackedBackgrounding = detectUntrackedShellBackgrounding(command);
      if (untrackedBackgrounding) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                reason: 'untracked_shell_background',
                message: formatUntrackedShellBackgroundAdvice(untrackedBackgrounding),
              }),
            },
          ],
          isError: true,
        };
      }
      // EI-21910156647461981: background tasks survive the caller's carry boundary.
      // A successor can therefore see the old task in the durable ledger while a
      // contradictory carry surface tells it to launch the same command again.
      // Compare the exact argv shape emitted by startBackground (bash -o pipefail
      // -c <command>) and the resolved cwd before creating another task. The
      // explicit override is reserved for callers that genuinely intend to run
      // the same command more than once.
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
      if (!args.allow_duplicate && workspaceId) {
        const expectedArgv = ['bash', '-o', 'pipefail', '-c', command];
        const duplicate = (await listLiveTasks(workspaceId)).find(
          (task) =>
            task.class === 'bash-job' &&
            task.cwd === cwd &&
            task.argv.length === expectedArgv.length &&
            task.argv.every((arg, index) => arg === expectedArgv[index]),
        );
        if (duplicate) {
          const bashId = duplicate.detail?.bashJobId;
          const taskHandle = `capability:bash_output { task_id: "${duplicate.taskId}" }`;
          const bashHandle =
            typeof bashId === 'string' && bashId.length > 0
              ? ` (or { bash_id: "${bashId}" } in the original launching context)`
              : '';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  reason: 'duplicate_live_task',
                  task_id: duplicate.taskId,
                  ...(typeof bashId === 'string' && bashId.length > 0 ? { bash_id: bashId } : {}),
                  cwd,
                  advice:
                    `A live background shell with the exact command and cwd already exists. ` +
                    `Reattach with ${taskHandle}${bashHandle}. ` +
                    'Pass allow_duplicate:true only when this duplicate launch is intentional.',
                }),
              },
            ],
            isError: true,
          };
        }
      }
    }
    // WI-6677: the default depends on the MODE. A background job is contractually
    // meant to outlive this call, so it must not inherit the short foreground
    // default — that made the tool SIGKILL exactly the long jobs it exists for.
    const requestedTimeoutMs =
      args.timeout ?? (args.run_in_background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // EI-20645849301780712: clamp the FOREGROUND timeout below the ~55s MCP transport cap,
    // exactly as capability:inspect / testing:run / build:typecheck already do. Without it this
    // tool advertised a foreground window (default 120s, arg max 600s) that the transport can
    // never deliver: past ~55s the CLIENT abandons the call and reports a generic failure — the
    // same token a real non-zero exit produces — so the agent cannot tell "my command failed"
    // from "the transport gave up", and (because no abort reaches the child) the command may
    // still have run to completion invisibly. Clamped, the TOOL self-times-out first and returns
    // `status: 'timed_out'` plus the log path and a re-run-detached hint.
    // A BACKGROUND job returns a handle immediately, so the cap does not apply to it.
    const timeoutMs = args.run_in_background ? requestedTimeoutMs : clampForegroundTimeoutMs(requestedTimeoutMs);
    // Resolve from server-owned caller identity. Trusted owner automation keeps
    // the rollout flag's compatibility behavior; confined work forces a real
    // wrapper and refuses before spawn when none is available.
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);
    // computer-tool-plan Gap C: if the calling bee's hive holds a leased sandbox desktop,
    // run its shell with DISPLAY bound to that desktop so GUI apps it launches (`firefox &`,
    // `soffice --calc &`) appear ON the leased Xvfb — capability:computer then drives them.
    // The handler runs in the OPERATOR process, so resolve per-caller from ctx.harnessSlug
    // (the bee's spawn-env never reaches here). No lease → no DISPLAY → unchanged. The lease
    // is always a sandbox display, never host :0.
    const hive = resolveConcreteHarnessSlug(undefined, ctx);
    const leasedDisplay = hive ? displayForHive(hive) : undefined;
    const desktopEnv = leasedDisplay ? { DISPLAY: leasedDisplay } : undefined;
    const integrationEntries = Object.entries(args.integration_env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (integrationEntries.length > 0 && ctx.isSuperuser !== true && !isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability:bash integration_env requires superuser or operator, architect, or mug authority');
    }

    const resolvedIntegrationEntries = await Promise.all(
      integrationEntries.map(async ([envName, sourceName]) => ({
        envName,
        sourceName,
        value: await readIntegrationKey(sourceName),
      })),
    );
    const missingIntegrationSources = [
      ...new Set(resolvedIntegrationEntries.filter((entry) => !entry.value).map((entry) => entry.sourceName)),
    ];
    if (missingIntegrationSources.length > 0) {
      throw new Error(
        `capability:bash integration_env references missing saved integration credential(s): ${missingIntegrationSources.join(', ')}`,
      );
    }
    const integrationEnv = Object.fromEntries(resolvedIntegrationEntries.map((entry) => [entry.envName, entry.value!]));
    const integrationEnvView = Object.fromEntries(
      resolvedIntegrationEntries.map((entry) => [
        entry.envName,
        {
          source: entry.sourceName,
          masked: maskIntegrationKey(entry.value),
        },
      ]),
    );
    // The operator process does not run inside the caller's psu shell, so its
    // inherited PAPERCUSP_SID is either absent or belongs to a different
    // session. Resolve the caller through the shared coordination identity
    // seam and explicitly bind that id to every child, including foreground
    // verifier commands. If this context cannot be attributed, clear the
    // inherited value rather than letting a stale operator identity authorize
    // a verifier against the wrong desktop.
    let callerSid = '';
    try {
      callerSid = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId.trim();
    } catch {
      callerSid = '';
    }
    const childEnv = {
      ...(desktopEnv ?? {}),
      ...integrationEnv,
      PAPERCUSP_SID: callerSid,
      // The marker is owned by this handler, not by caller-provided env. A
      // foreground timeout kills the entire process tree, so mutation probes
      // must refuse --in-tree before they touch a tracked file. Background
      // jobs explicitly clear both names so a stale inherited value cannot
      // make a detached probe refuse for the wrong reason.
      [CAPABILITY_BASH_FOREGROUND_ENV]: args.run_in_background ? '' : '1',
      [CAPABILITY_BASH_FOREGROUND_TIMEOUT_ENV]: args.run_in_background ? '' : String(timeoutMs),
    };
    const redactValues = resolvedIntegrationEntries.map((entry) => entry.value!);
    const integrationHeader =
      integrationEntries.length > 0 ? ` · integration_env ${JSON.stringify(integrationEnvView)}` : '';

    if (args.run_in_background) {
      const provenance = await resolveBashTaskProvenance(ctx as unknown as ResolveIdentityCtx, hive ?? null);
      const frozenRefusal = await frozenLineageRefusal();
      if (frozenRefusal) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(frozenRefusal) }],
          isError: true,
        };
      }
      const job = startBackground(
        {
          command: command,
          cwd,
          stateDir: ctx.stateDir,
          sandboxEnabled: sandboxPolicy.enabled,
          sandboxRequired: sandboxPolicy.required,
          ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
          ...(redactValues.length > 0 ? { redactValues } : {}),
          ...provenance,
        },
        timeoutMs,
      );
      // EI-19915289191989412: a command whose LAST pipeline stage is a buffering
      // filter (`| tail -45`, `| head`, `| sort`, …) does not flush anything to
      // the job's log until the WHOLE pipeline exits — the log stays at exactly
      // 0 bytes for the entire run, then fills all at once at exit. Say so NOW,
      // at launch, rather than leaving the reader to discover it from a string of
      // empty bash_output polls that look identical to "never started".
      const bufferingStage = detectBufferingLastStage(command);
      const bufferingNote = bufferingStage ? formatBufferingPipelineAdvice(bufferingStage, 'launch') : '';
      // EI-21301075566136325: same say-it-NOW rationale as the buffering note — a
      // command that redirects its own stdout keeps the capability log empty for
      // its whole run, and a string of empty bash_output polls looks identical to
      // "never started". Name the redirect target at launch so the reader judges
      // progress by THAT file, not by the capability tail.
      const selfRedirectAtLaunch = detectSelfOutputRedirect(command);
      const selfRedirectLaunchNote = selfRedirectAtLaunch
        ? ` ${formatSelfRedirectAdvice(selfRedirectAtLaunch, null)}`
        : '';
      // EI-20063051138162607: the sibling typecheck tools spawn tsc themselves and
      // so can pin its heap (tscHeapEnv); this one runs a command the CALLER wrote,
      // and rewriting NODE_OPTIONS underneath it would be the more surprising
      // behavior. So say it instead of fixing it — the caller keeps sovereignty
      // over the command, and stops needing to know the heap requirement by heart.
      const heapNote = typecheckHeapLaunchWarning(command) ?? '';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              task_id: job.taskId,
              status: 'running',
              cwd,
              log_path: job.logPath,
              // WI-6677: state the deadline at LAUNCH. It is enforced by SIGTERM/SIGKILL,
              // so a caller who needs longer must know now — not discover it as an
              // unexplained death two hours in.
              timeout_ms: job.timeoutMs,
              deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
              ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
              advice:
                `Background shell started. Preserve durable task_id "${job.taskId}" across carry. ` +
                `Read output: capability:bash_output { task_id: "${job.taskId}" } ` +
                `(or { bash_id: "${job.id}" } in this launching context). ` +
                `Stop: processes:kill { taskId: "${job.taskId}" }. ` +
                `It is terminated at ${job.deadlineAt ? new Date(job.deadlineAt).toISOString() : 'its deadline'} — ` +
                `re-launch with a larger \`timeout\` (max ${MAX_BACKGROUND_TIMEOUT_MS}ms) if the shell job needs longer. ` +
                `All descendants in this task's confined service share that deadline; use a dedicated service launcher ` +
                `when a descendant needs a separate lifetime.` +
                bufferingNote +
                selfRedirectLaunchNote +
                heapNote,
            }),
          },
        ],
      };
    }

    const frozenRefusal = await frozenLineageRefusal();
    if (frozenRefusal) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(frozenRefusal) }],
        isError: true,
      };
    }

    const r = await runForeground(
      {
        command: command,
        cwd,
        stateDir: ctx.stateDir,
        onChunk: (chunk) => ctx.emit('output', chunk),
        sandboxEnabled: sandboxPolicy.enabled,
        sandboxRequired: sandboxPolicy.required,
        ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
        ...(redactValues.length > 0 ? { redactValues } : {}),
      },
      ctx.signal,
      timeoutMs,
    );

    const header =
      `exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '') +
      integrationHeader;

    const isError = r.status === 'failed' && r.exitCode === null;
    // EI-20645849301780712: on a clamped timeout, say so — and name the spill log, which is
    // where the partial output lives and is otherwise only surfaced when output OVERFLOWED.
    const timeoutHint = foregroundTimeoutHint(
      r.status,
      timeoutMs,
      'capability:bash { …same command…, run_in_background: true }',
    );
    const timeoutLogNote = r.status === 'timed_out' && !r.truncated ? ` Partial output: ${r.logPath}.` : '';

    return {
      content: [
        { type: 'text' as const, text: `${header}\n${r.output || '(no output)'}${timeoutHint}${timeoutLogNote}` },
      ],
      isError,
      // EI-20066912585022608: the text above is the right answer for a MODEL reading
      // this result and the wrong one for a `code:run` script, which gets handed the
      // raw string and whose `result.<field>` then resolves to undefined SILENTLY —
      // indistinguishable from a true empty. Worse, this tool's own background branch
      // returns JSON, so `capability.bash(...)` changed shape depending on an argument.
      // Give code-mode the same data the header renders, and only code-mode: attaching
      // it unconditionally would duplicate every foreground command's output on the
      // wire for direct callers that read the text and never look at this field.
      //
      // `output` is deliberately NOT called `stdout` — bash-jobs pipes stdout and
      // stderr into one buffer, so `stdout` would be a name that reads right and is
      // false, which is the same defect class one level down. A script that guesses
      // `.stdout` now gets a loud fieldMiss naming the real keys instead of ''.
      ...(ctx.codeMode
        ? {
            structuredContent: {
              // `ok` answers the question a script actually asks — "did my command
              // succeed" — NOT the narrower "did the shell manage to run it"
              // (`isError`, reserved for a command that never produced an exit code).
              // `status === 'completed'` is exactly `exitCode === 0` in bash-jobs;
              // 'failed' | 'killed' | 'timed_out' all read as ok:false, and `status`
              // is what distinguishes "it ran and failed" from "it never finished".
              // Defining ok as !isError instead would hand back ok:true for a command
              // that exited 3 — the reads-true-but-false shape this whole item is about.
              ok: r.status === 'completed',
              status: r.status,
              exit_code: r.exitCode,
              duration_ms: r.durationMs,
              cwd,
              output: r.output,
              truncated: r.truncated,
              ...(integrationEntries.length > 0 ? { integration_env: integrationEnvView } : {}),
              ...(r.truncated ? { total_bytes: r.totalBytes, log_path: r.logPath } : {}),
              // A timed_out run's partial output is ONLY on disk unless it also overflowed —
              // a script reading this result needs the path in both cases (EI-20645849301780712).
              ...(r.status === 'timed_out' && !r.truncated ? { log_path: r.logPath } : {}),
            },
          }
        : {}),
    };
  },
});
