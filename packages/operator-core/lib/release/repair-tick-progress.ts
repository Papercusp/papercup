/** Exact-head diagnostic receipts. Stored in the existing frozen queue, never promotion proof. */
export interface RepairTickCommand {
  key: string;
  gateId: string;
  script: string;
  workspace: string | null;
}

export interface RepairTickCommandResult {
  status: 'pass' | 'fail' | 'errored' | 'skipped' | 'not-checked';
  durationMs: number;
  outputTail?: string;
  subjectPaths?: string[];
  subjectPathsComplete?: boolean;
}

export interface RepairTickProgress {
  schemaVersion: 1;
  candidate: string;
  head: string;
  openedAtMs: number;
  commands: RepairTickCommand[];
  /** Advanced and saved BEFORE launch, so a crash cannot repeatedly starve the suffix. */
  cursor: number;
  states: Partial<Record<string, {
    status: 'running' | 'aborted' | 'complete';
    attempts: number;
    result?: RepairTickCommandResult;
  }>>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Reject a corrupt receipt set intact; never drop its unrecognized entries. */
export function readRepairTickProgressHistory(value: unknown): RepairTickProgress[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('repair-tick-progress: unreadable history');
  for (const row of value) {
    if (!object(row) || row.schemaVersion !== 1 || !nonblank(row.candidate) || !nonblank(row.head) ||
      !timestamp(row.openedAtMs) || !Array.isArray(row.commands) || !object(row.states) ||
      !Number.isInteger(row.cursor) || Number(row.cursor) < 0 || Number(row.cursor) >= Math.max(1, row.commands.length)) {
      throw new Error('repair-tick-progress: unreadable scope or cursor');
    }
    const keys = new Set<string>();
    for (const command of row.commands) {
      if (!object(command) || !nonblank(command.key) || !nonblank(command.gateId) || !nonblank(command.script) ||
        !(command.workspace === null || nonblank(command.workspace)) || keys.has(command.key)) {
        throw new Error('repair-tick-progress: unreadable or duplicate command');
      }
      keys.add(command.key);
    }
    for (const [key, state] of Object.entries(row.states)) {
      if (!keys.has(key) || !object(state) || !Number.isInteger(state.attempts) || Number(state.attempts) < 1 ||
        !['running', 'aborted', 'complete'].includes(String(state.status))) {
        throw new Error('repair-tick-progress: unreadable command state');
      }
      if (state.status === 'complete') {
        const result = state.result;
        if (!object(result) || !['pass', 'fail', 'errored', 'skipped', 'not-checked'].includes(String(result.status)) ||
          !timestamp(result.durationMs) || (result.outputTail !== undefined && typeof result.outputTail !== 'string') ||
          (result.subjectPaths !== undefined && (!Array.isArray(result.subjectPaths) || !result.subjectPaths.every(nonblank))) ||
          (result.subjectPathsComplete !== undefined && typeof result.subjectPathsComplete !== 'boolean')) {
          throw new Error('repair-tick-progress: unreadable completed receipt');
        }
      } else if (state.result !== undefined) throw new Error('repair-tick-progress: unfinished command has a result');
    }
  }
  return structuredClone(value) as RepairTickProgress[];
}

function identity(progress: Pick<RepairTickProgress, 'candidate' | 'head' | 'openedAtMs' | 'commands'>): string {
  return JSON.stringify([progress.candidate, progress.head, progress.openedAtMs,
    progress.commands.map((command) => [command.key, command.gateId, command.script, command.workspace])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

export function prepareRepairTickProgress(
  scope: Pick<RepairTickProgress, 'candidate' | 'head' | 'openedAtMs'>,
  commands: RepairTickCommand[],
  history: unknown,
): RepairTickProgress {
  const fresh: RepairTickProgress = { schemaVersion: 1, ...scope, commands, cursor: 0, states: {} };
  // Validate new identities as well as persisted ones. A malformed identity is never shortened.
  readRepairTickProgressHistory([fresh]);
  return readRepairTickProgressHistory(history).find((entry) => identity(entry) === identity(fresh)) ?? fresh;
}

/** Keep older heads/manifests recoverable while replacing only this exact scope's checkpoint. */
export function storeRepairTickProgress(history: unknown, progress: RepairTickProgress): RepairTickProgress[] {
  const entries = readRepairTickProgressHistory(history);
  readRepairTickProgressHistory([progress]);
  const index = entries.findIndex((entry) => identity(entry) === identity(progress));
  if (index < 0) entries.push(structuredClone(progress));
  else entries[index] = structuredClone(progress);
  return entries;
}

/** One fair pass over unfinished commands; completed positive AND negative receipts are reused. */
export function pendingRepairTickCommands(progress: RepairTickProgress): RepairTickCommand[] {
  const ordered = [...progress.commands.slice(progress.cursor), ...progress.commands.slice(0, progress.cursor)];
  return ordered.filter((command) => progress.states[command.key]?.status !== 'complete');
}

export function startRepairTickCommand(progress: RepairTickProgress, key: string): RepairTickProgress {
  const index = progress.commands.findIndex((command) => command.key === key);
  if (index < 0) throw new Error('repair-tick-progress: command outside manifest');
  return { ...progress, cursor: (index + 1) % progress.commands.length,
    states: { ...progress.states, [key]: { status: 'running', attempts: (progress.states[key]?.attempts ?? 0) + 1 } } };
}

export function finishRepairTickCommand(
  progress: RepairTickProgress, key: string, result?: RepairTickCommandResult,
): RepairTickProgress {
  const state = progress.states[key];
  if (!state || state.status !== 'running') throw new Error('repair-tick-progress: command was not started');
  return { ...progress, states: { ...progress.states,
    [key]: { attempts: state.attempts, status: result ? 'complete' : 'aborted', ...(result ? { result } : {}) } } };
}

export function repairTickProgressSummary(progress: RepairTickProgress) {
  const remainingCommands = pendingRepairTickCommands(progress).map((command) => ({
    ...command, status: progress.states[command.key]?.status ?? 'pending',
  }));
  return { complete: remainingCommands.length === 0, totalCommandCount: progress.commands.length,
    completedCommandCount: progress.commands.length - remainingCommands.length, remainingCommands,
    recovery: 'The next ordinary repair tick resumes repairQueue.repairTickProgress at this exact scope and head.' };
}
