/**
 * stats-proof.ts — print the measured stat block behind the pitch deck.
 *
 *   npm run stats:proof            # human-readable block
 *   npm run stats:proof -- --json  # machine-readable, for a slide generator
 *
 * WHY (WI-35490): the deck claims "every figure is measured from the repository and
 * the live database, and reproducible on request." Nothing delivered that, so the
 * figures were rebuilt by hand each time — and slide 11 shipped
 * `113,527 COORDINATION EVENTS / ALL TIME` over a retention-swept table, which
 * re-measures LOWER. This command is the artifact that makes the promise true, and
 * `lib/stat-proof-block.ts` holds the guard that makes the bad shape
 * unrepresentable rather than merely corrected once.
 *
 * TWO MEASUREMENT DISCIPLINES WORTH KEEPING
 *
 * 1. Lines are counted IN THIS PROCESS, not by shelling to `xargs wc -l`. With
 *    ~11.5k files, xargs splits into several batches and emits one "total" PER
 *    BATCH, so the familiar `| tail -1` reads only the LAST batch's subtotal and
 *    silently under-reports by millions. That mistake produced a wrong line count
 *    during this very investigation, so the fix does not get to depend on it.
 *
 * 2. Retention horizons are IMPORTED from the GC modules that enforce them, never
 *    restated here. Retune retention and this command's output follows; restate it
 *    and the two drift, which is how the bad tile happened.
 *
 * Scope is stated per figure rather than assumed. The deck's work-item figure was
 * harness-scoped, so this keeps that basis — a trend line is only meaningful if the
 * denominator stays put, and quietly widening a scope invites exactly the "did you
 * change the basis to look better?" reading this command exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { NOTIFY_GC_RETENTION_DAYS } from '../packages/operator-core/lib/agent-tools/coordination/notify-gc';
import {
  MESSAGE_GC_RETENTION_DAYS,
  FEDERATED_MESSAGE_GC_RETENTION_DAYS,
} from '../packages/operator-core/lib/agent-tools/coordination/message-log-gc';
import { ESCALATION_GC_RETENTION_DAYS } from '../packages/operator-core/lib/agent-tools/coordination/escalation-log-gc';
import {
  renderStatBlock,
  type LedgerFigure,
} from '../packages/operator-core/lib/stat-proof-block';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every horizon known to sweep coord_event_log, from the GCs that enforce them. */
const COORD_EVENT_LOG_HORIZONS_DAYS = [
  NOTIFY_GC_RETENTION_DAYS,
  FEDERATED_MESSAGE_GC_RETENTION_DAYS,
  ESCALATION_GC_RETENTION_DAYS,
  MESSAGE_GC_RETENTION_DAYS,
];

/** The workspace/harness the published figures describe. */
const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';

/** Trailing window for rate figures. */
const WINDOW_DAYS = 7;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Tracked files matching the given pathspecs, excluding retired code. */
function trackedFiles(patterns: string[]): string[] {
  return git('ls-files', '-z', ...patterns)
    .split('\0')
    .filter((f) => f.length > 0 && !f.startsWith('_retired/'));
}

/**
 * Total newline count across `files` — matching `wc -l` semantics exactly (it
 * counts newline BYTES, so a file with no trailing newline reports one fewer line
 * than it has visually). Counted here rather than shelled out; see header note 1.
 */
function countLines(files: string[]): number {
  let total = 0;
  for (const rel of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(REPO_ROOT, rel));
    } catch {
      continue; // tracked but absent (submodule gitlink, sparse checkout)
    }
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) total++;
  }
  return total;
}

function firstCommitDate(): Date {
  const out = git('log', '--reverse', '--format=%aI', '--max-parents=0').trim();
  const first = out.split('\n')[0]?.trim();
  if (!first) throw new Error('could not resolve the repository first-commit date');
  return new Date(first);
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const measuredAt = new Date();

  // ---- repository figures -------------------------------------------------
  const tsFiles = trackedFiles(['*.ts', '*.tsx']);
  const testFiles = trackedFiles(['*.test.ts', '*.test.tsx', '*.spec.ts']);
  const rustFiles = trackedFiles(['*.rs']).filter((f) => !f.includes('vendor'));

  const totalLines = countLines(tsFiles);
  const testLines = countLines(testFiles);
  const rustLines = countLines(rustFiles);
  const migrations = trackedFiles(['libs/papercusp/libs/db/sql/*.sql']).length;
  const blueprints = new Set(
    trackedFiles(['libs/papercusp/packages/harness/blueprints/*'])
      .map((f) => f.split('/')[5])
      .filter(Boolean),
  ).size;

  const catalog = JSON.parse(
    readFileSync(join(REPO_ROOT, '.papercusp/tool-catalog.json'), 'utf8'),
  ) as { count?: number; tools: Array<{ name: string }> };
  const tools = catalog.count ?? catalog.tools.length;
  const toolGroups = new Set(catalog.tools.map((t) => t.name.split(':')[0])).size;

  // ---- live ledger figures ------------------------------------------------
  const sql = postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 5 });
  let ledger: LedgerFigure[];
  try {
    const [row] = await sql<
      Array<{
        tool_calls: string;
        agents: string;
        coord_events: string;
        work_items: string;
        work_items_terminal: string;
        work_items_oldest: Date | null;
        harnesses: string;
      }>
    >`
      SELECT
        (SELECT count(*) FROM harness_shared.tool_invocations
          WHERE workspace_id = ${WORKSPACE}
            AND invoked_at > now() - make_interval(days => ${WINDOW_DAYS})) AS tool_calls,
        (SELECT count(DISTINCT coord_owner_id) FROM harness_shared.tool_invocations
          WHERE workspace_id = ${WORKSPACE}
            AND invoked_at > now() - make_interval(days => ${WINDOW_DAYS})) AS agents,
        (SELECT count(*) FROM harness_shared.coord_event_log
          WHERE workspace_id = ${WORKSPACE}
            AND ts > now() - make_interval(days => ${WINDOW_DAYS})) AS coord_events,
        (SELECT count(*) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}) AS work_items,
        (SELECT count(*) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
            AND status IN ('done','resolved','passed','closed')) AS work_items_terminal,
        (SELECT to_timestamp(min(created_ts) / 1000.0) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
            AND created_ts > 0) AS work_items_oldest,
        (SELECT count(DISTINCT harness_slug) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE}) AS harnesses
    `;

    const firstCommit = firstCommitDate();
    const wiOldest = row.work_items_oldest ?? firstCommit;

    ledger = [
      {
        id: 'tool-calls',
        label: 'AGENT TOOL CALLS',
        value: Number(row.tool_calls),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.tool_invocations (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [], // not swept
      },
      {
        id: 'distinct-agents',
        label: 'DISTINCT AGENTS',
        value: Number(row.agents),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.tool_invocations (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [],
      },
      {
        id: 'work-items',
        label: 'WORK ITEMS IN THE LEDGER',
        value: Number(row.work_items),
        window: {
          kind: 'since-observed',
          oldestRow: wiOldest,
          // Tolerance: the ledger cannot predate the repo, so "reaches first
          // commit" means its oldest row is at/near the first commit.
          reachesProjectStart: wiOldest.getTime() - firstCommit.getTime() < 14 * 86_400_000,
        },
        sourceTable: `harness_shared.work_items (harness=${HARNESS})`,
        retentionHorizonsDays: [],
      },
      {
        id: 'work-items-terminal',
        label: 'WORK ITEMS DRIVEN TO DONE',
        value: Number(row.work_items_terminal),
        window: {
          kind: 'since-observed',
          oldestRow: wiOldest,
          reachesProjectStart: wiOldest.getTime() - firstCommit.getTime() < 14 * 86_400_000,
        },
        sourceTable: `harness_shared.work_items (harness=${HARNESS})`,
        retentionHorizonsDays: [],
      },
      {
        // The figure that was published wrong. It is a swept table, so the guard
        // forces a trailing window; wider than the 3d notify horizon, so a FLOOR.
        id: 'coord-events',
        label: 'COORDINATION EVENTS',
        value: Number(row.coord_events),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.coord_event_log (workspace=${WORKSPACE})`,
        retentionHorizonsDays: COORD_EVENT_LOG_HORIZONS_DAYS,
      },
      {
        id: 'harnesses',
        label: 'DISTINCT WORK CONTEXTS',
        value: Number(row.harnesses),
        window: { kind: 'repo-snapshot' },
        sourceTable: `harness_shared.work_items (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [],
      },
    ];

    const out = renderStatBlock({
      measuredAt,
      firstCommit,
      repo: {
        totalLines,
        totalFiles: tsFiles.length,
        testLines,
        testFiles: testFiles.length,
        rustLines,
        migrations,
        tools,
        toolGroups,
        blueprints,
        basis: 'git-tracked TypeScript, excluding _retired/ (git ls-files; newlines counted in-process)',
      },
      ledger,
    });

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            measuredAt: measuredAt.toISOString(),
            firstCommit: firstCommit.toISOString(),
            repo: {
              totalLines,
              totalFiles: tsFiles.length,
              testLines,
              testFiles: testFiles.length,
              rustLines,
              migrations,
              tools,
              toolGroups,
              blueprints,
            },
            figures: out.figures,
            warnings: out.warnings,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(out.text);
      if (out.warnings.length > 0) {
        console.log('NOTES');
        console.log('-'.repeat(72));
        for (const w of out.warnings) console.log(`  ${w}`);
        console.log('');
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // A guard failure must fail the COMMAND — a bad figure never reaches a slide.
  console.error(`\nstats:proof FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
