#!/usr/bin/env -S npx tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
  TaskReleaseReceiptInput,
  TaskReleaseReceiptState,
} from '@papercusp/operator-core/lib/task-manager/store';

export interface ReleaseTaskLedger {
  getTask(taskId: string): Promise<{ detail?: Record<string, unknown> | null } | null>;
  taskReleaseJournalFromDetail(detail: Record<string, unknown> | null | undefined): TaskReleaseJournal | null;
  appendTaskReleaseReceipt(
    taskId: string,
    expectedCursor: number,
    input: TaskReleaseReceiptInput,
  ): Promise<AppendTaskReleaseReceiptResult>;
}

export interface ReleaseTaskIdentity {
  sourceSha: string;
  gitlinks: Readonly<Record<string, string>>;
  version: string;
  channel: string;
}

export interface ReleaseTaskStageContext {
  taskId: string;
  operationId: string;
  ledger: ReleaseTaskLedger;
  identity: ReleaseTaskIdentity;
  credentialGeneration?: string | null;
  credentialExpiresAt?: string | null;
}

export interface ReleaseTaskStageInput {
  stage: string;
  identity: string;
}

export interface ReleaseTaskStageInspection {
  action: 'ready' | 'reuse' | 'reconcile' | 'refused';
  inputHash: string;
  requestIdentity: string | null;
  state: TaskReleaseReceiptState | 'absent';
  attempt: number;
  cursor: number;
  journal: TaskReleaseJournal;
}

export type BegunReleaseTaskStage = Omit<ReleaseTaskStageInspection, 'action'> & {
  action: 'run' | 'reuse' | 'reconcile' | 'refused';
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release stage identity contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new Error('release stage identity contains a non-JSON value');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (entry === undefined) throw new Error(`release stage identity field '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .join(',')}}`;
}

export function releaseStageInputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Stable UUIDv4-shaped identity accepted by provider APIs that expose idempotency keys. */
export function releaseStageRequestIdentity(
  operationId: string,
  stage: string,
  inputHash: string,
  attempt = 0,
): string {
  const hex = createHash('sha256')
    .update(`${operationId}\u0000${stage}\u0000${inputHash}\u0000${attempt}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function readSourceGitlinks(sourceRoot: string, sourceSha: string): Record<string, string> {
  const gitmodules = execFileSync('git', ['-C', sourceRoot, 'show', `${sourceSha}:.gitmodules`], {
    encoding: 'utf8',
  });
  const paths = [...gitmodules.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
    .map((match) => match[1]!)
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`release source ${sourceSha} has no unique committed .gitmodules paths`);
  }
  const tree = execFileSync('git', ['-C', sourceRoot, 'ls-tree', sourceSha, '--', ...paths], {
    encoding: 'utf8',
  });
  const gitlinks: Record<string, string> = {};
  for (const line of tree.split('\n')) {
    const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (match) gitlinks[match[2]!] = match[1]!;
  }
  const missing = paths.filter((entry) => !Object.hasOwn(gitlinks, entry));
  if (missing.length > 0) {
    throw new Error(`release source ${sourceSha} has non-gitlink submodule path(s): ${missing.join(', ')}`);
  }
  return sortedRecord(gitlinks);
}

export function assertReleaseTaskIdentity(
  journal: TaskReleaseJournal,
  expected: ReleaseTaskIdentity,
): void {
  const source = journal.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('release journal has no immutable source identity');
  }
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.sha !== expected.sourceSha) {
    throw new Error(`release journal source ${String(sourceRecord.sha)} does not match ${expected.sourceSha}`);
  }
  const rawGitlinks = sourceRecord.gitlinks;
  if (!rawGitlinks || typeof rawGitlinks !== 'object' || Array.isArray(rawGitlinks)) {
    throw new Error('release journal has no immutable gitlink map');
  }
  const journalGitlinks = rawGitlinks as Record<string, unknown>;
  if (!Object.values(journalGitlinks).every((sha) => typeof sha === 'string')) {
    throw new Error('release journal gitlink map is malformed');
  }
  const recorded = sortedRecord(journalGitlinks as Record<string, string>);
  const current = sortedRecord(expected.gitlinks);
  if (canonicalJson(recorded) !== canonicalJson(current)) {
    throw new Error('release journal gitlink tuple does not match the exact source tree');
  }

  const artifact = journal.artifactIdentity;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('release journal has no immutable artifact identity');
  }
  const identity = artifact as Record<string, unknown>;
  if (
    identity.sourceSha !== expected.sourceSha ||
    identity.version !== expected.version ||
    identity.channel !== expected.channel
  ) {
    throw new Error(
      `release journal artifact identity does not match source/version/channel ` +
        `${expected.sourceSha}/${expected.version}/${expected.channel}`,
    );
  }
}

async function readJournal(context: ReleaseTaskStageContext): Promise<TaskReleaseJournal> {
  const task = await context.ledger.getTask(context.taskId);
  if (!task) throw new Error(`release task ${context.taskId} is absent from the task ledger`);
  const journal = context.ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) throw new Error(`release task ${context.taskId} has no complete release journal`);
  if (journal.operationId !== context.operationId) {
    throw new Error(
      `release task ${context.taskId} belongs to operation ${journal.operationId}, not ${context.operationId}`,
    );
  }
  assertReleaseTaskIdentity(journal, context.identity);
  return journal;
}

function latestReceipt(receipts: readonly TaskReleaseReceipt[], requestIdentity: string): TaskReleaseReceipt | null {
  return [...receipts].reverse().find((receipt) => receipt.requestIdentity === requestIdentity) ?? null;
}

function stageReceipts(
  journal: TaskReleaseJournal,
  stage: string,
  inputHash: string,
): TaskReleaseReceipt[] {
  const receipts = journal.receipts.filter((receipt) => receipt.stage === stage);
  const conflict = receipts.find((receipt) => receipt.inputHash !== inputHash);
  if (conflict) {
    throw new Error(
      `release stage ${stage} input changed within operation ${journal.operationId}; ` +
        `receipt ${conflict.sequence} pins ${conflict.inputHash}, current input is ${inputHash}`,
    );
  }
  return receipts;
}

function inspectJournal(
  journal: TaskReleaseJournal,
  input: ReleaseTaskStageInput,
): ReleaseTaskStageInspection {
  const inputHash = releaseStageInputHash({ identity: input.identity });
  const receipts = stageReceipts(journal, input.stage, inputHash);
  const identities = [...new Set(receipts.map((receipt) => receipt.requestIdentity))];
  const requestIdentity = identities.at(-1) ?? null;
  const prior = requestIdentity ? latestReceipt(receipts, requestIdentity) : null;
  const state = prior?.state ?? 'absent';
  const action =
    state === 'committed'
      ? 'reuse'
      : state === 'intent' || state === 'unknown'
        ? 'reconcile'
        : state === 'refused' && !prior?.evidenceRefs.includes('reconcile:confirmed-absent')
          ? 'refused'
          : 'ready';
  return {
    action,
    inputHash,
    requestIdentity,
    state,
    attempt: identities.length,
    cursor: journal.cursor,
    journal,
  };
}

export async function inspectReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput,
): Promise<ReleaseTaskStageInspection> {
  return inspectJournal(await readJournal(context), input);
}

export async function beginReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput,
): Promise<BegunReleaseTaskStage> {
  for (let cursorAttempt = 0; cursorAttempt < 12; cursorAttempt += 1) {
    const inspection = await inspectReleaseTaskStage(context, input);
    if (
      inspection.action === 'reuse' ||
      inspection.action === 'reconcile' ||
      inspection.action === 'refused'
    ) {
      return { ...inspection, action: inspection.action };
    }
    const requestIdentity = releaseStageRequestIdentity(
      context.operationId,
      input.stage,
      inspection.inputHash,
      inspection.attempt,
    );
    const appended = await context.ledger.appendTaskReleaseReceipt(
      context.taskId,
      inspection.cursor,
      {
        operationId: context.operationId,
        requestIdentity,
        stage: input.stage,
        state: 'intent',
        inputHash: inspection.inputHash,
        evidenceRefs: [`stage-input:${inspection.inputHash}`],
        credentialGeneration: context.credentialGeneration ?? null,
        credentialExpiresAt: context.credentialExpiresAt ?? null,
      },
    );
    if (appended.ok) {
      return {
        ...inspectJournal(appended.journal, input),
        action: 'run',
        requestIdentity,
        state: 'intent',
      };
    }
    if (appended.reason === 'cursor_mismatch' || appended.reason === 'cas_conflict') continue;
    throw new Error(`release journal refused ${input.stage}/${requestIdentity}/intent: ${appended.reason}`);
  }
  throw new Error(`release journal stayed contended while beginning ${input.stage}`);
}

export async function settleReleaseTaskStage(
  context: ReleaseTaskStageContext,
  input: ReleaseTaskStageInput & {
    requestIdentity: string;
    state: Exclude<TaskReleaseReceiptState, 'intent'>;
    evidenceRefs?: readonly string[];
  },
): Promise<ReleaseTaskStageInspection> {
  for (let cursorAttempt = 0; cursorAttempt < 12; cursorAttempt += 1) {
    const inspection = await inspectReleaseTaskStage(context, input);
    if (inspection.requestIdentity !== input.requestIdentity) {
      throw new Error(
        `release stage ${input.stage} active request ${inspection.requestIdentity ?? '(absent)'} ` +
          `does not match ${input.requestIdentity}`,
      );
    }
    if (inspection.state === input.state) return inspection;
    if (inspection.state !== 'intent' && inspection.state !== 'unknown') {
      throw new Error(
        `release stage ${input.stage}/${input.requestIdentity} cannot transition ` +
          `${inspection.state} -> ${input.state}`,
      );
    }
    const appended = await context.ledger.appendTaskReleaseReceipt(
      context.taskId,
      inspection.cursor,
      {
        operationId: context.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: inspection.inputHash,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: context.credentialGeneration ?? null,
        credentialExpiresAt: context.credentialExpiresAt ?? null,
      },
    );
    if (appended.ok) return inspectJournal(appended.journal, input);
    if (appended.reason === 'cursor_mismatch' || appended.reason === 'cas_conflict') continue;
    throw new Error(
      `release journal refused ${input.stage}/${input.requestIdentity}/${input.state}: ${appended.reason}`,
    );
  }
  throw new Error(`release journal stayed contended while settling ${input.stage}/${input.state}`);
}

interface CliArgs {
  command: 'status' | 'begin' | 'commit' | 'unknown' | 'refuse';
  taskId: string;
  operationId: string;
  sourceRoot: string;
  sourceSha: string;
  version: string;
  channel: string;
  stage: string;
  identity: string;
  requestIdentity?: string;
  evidenceRefs: string[];
}

function cliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
  const [rawCommand, ...rest] = argv;
  if (!['status', 'begin', 'commit', 'unknown', 'refuse'].includes(rawCommand ?? '')) {
    throw new Error('usage: release-task-journal.ts <status|begin|commit|unknown|refuse> --stage NAME --identity VALUE ...');
  }
  const values = new Map<string, string>();
  const evidenceRefs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected release journal argument ${arg}`);
    const equal = arg.indexOf('=');
    const key = equal >= 0 ? arg.slice(2, equal) : arg.slice(2);
    const value = equal >= 0 ? arg.slice(equal + 1) : rest[++index];
    if (value === undefined) throw new Error(`release journal argument --${key} requires a value`);
    if (key === 'evidence') evidenceRefs.push(value);
    else values.set(key, value);
  }
  const required = (key: string, fallback?: string): string => {
    const value = values.get(key) ?? fallback;
    if (!value?.trim()) throw new Error(`release journal requires --${key}`);
    return value.trim();
  };
  const command = rawCommand as CliArgs['command'];
  const requestIdentity = values.get('request-id');
  if (command !== 'status' && command !== 'begin' && !requestIdentity) {
    throw new Error(`release journal ${command} requires --request-id`);
  }
  return {
    command,
    taskId: required('task-id', env.PAPERCUSP_RELEASE_TASK_ID),
    operationId: required('operation-id', env.PAPERCUSP_RELEASE_OPERATION_ID),
    sourceRoot: required('source-root'),
    sourceSha: required('source-sha', env.PAPERCUSP_EXPECTED_SOURCE_SHA),
    version: required('version'),
    channel: required('channel'),
    stage: required('stage'),
    identity: required('identity'),
    ...(requestIdentity ? { requestIdentity } : {}),
    evidenceRefs,
  };
}

async function defaultLedger(): Promise<ReleaseTaskLedger> {
  const store = await import('@papercusp/operator-core/lib/task-manager/store');
  return {
    getTask: store.getTask,
    taskReleaseJournalFromDetail: store.taskReleaseJournalFromDetail,
    appendTaskReleaseReceipt: store.appendTaskReleaseReceipt,
  };
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2), process.env);
  const context: ReleaseTaskStageContext = {
    taskId: args.taskId,
    operationId: args.operationId,
    ledger: await defaultLedger(),
    identity: {
      sourceSha: args.sourceSha,
      gitlinks: readSourceGitlinks(args.sourceRoot, args.sourceSha),
      version: args.version,
      channel: args.channel,
    },
    credentialGeneration: process.env.PAPERCUSP_RELEASE_CREDENTIAL_GENERATION?.trim() || null,
    credentialExpiresAt: process.env.PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT?.trim() || null,
  };
  const stage = { stage: args.stage, identity: args.identity };
  const result =
    args.command === 'status'
      ? await inspectReleaseTaskStage(context, stage)
      : args.command === 'begin'
        ? await beginReleaseTaskStage(context, stage)
        : await settleReleaseTaskStage(context, {
            ...stage,
            requestIdentity: args.requestIdentity!,
            state: args.command === 'commit' ? 'committed' : args.command === 'refuse' ? 'refused' : 'unknown',
            evidenceRefs:
              args.command === 'refuse'
                ? ['reconcile:confirmed-absent', ...args.evidenceRefs]
                : args.evidenceRefs,
          });
  process.stdout.write(`${JSON.stringify({
    action: result.action,
    state: result.state,
    requestIdentity: result.requestIdentity,
    inputHash: result.inputHash,
    attempt: result.attempt,
  })}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
