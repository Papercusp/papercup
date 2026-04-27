/**
 * Project Manager dispatch — spawn claude with the PM role prompt for a
 * specific project, parse the three-section output, persist the new spec
 * revision, and mark consumed pm_due events.
 *
 * Output format produced by `prompts/project_manager.md`:
 *
 *   PROJECT_MANAGER_DECISIONS
 *   [{"feature_id": "F-XXX", "action": "include|exclude", "reason": "..."}]
 *   ---
 *   PROJECT_MANAGER_SPEC
 *   <full updated spec body, or the literal token `NO_CHANGE`>
 *   ---
 *   PROJECT_MANAGER_SUMMARY
 *   <one-line summary>
 *
 * Concurrency safety: takes a Postgres advisory lock keyed on the project
 * id. A second PM run for the same project waits or aborts depending on
 * the caller's `lockMode` choice.
 */
import { spawn } from 'node:child_process';
import { getLegacyClient } from '@restart/db-org';
import { assembleRolePrompt } from './assemble-role-prompt';

export interface RunPmOptions {
  slug: string;
  projectId: string;
  /** Override claude command (default: `process.env.CLAUDE_CMD ?? 'claude'`). */
  claudeCmd?: string;
  /** Force a run even if no pending pm_due events exist (manual trigger). */
  bypassDebounce?: boolean;
}

export interface RunPmResult {
  ok: true;
  revision_id: number | null;            // null if NO_CHANGE
  changed: boolean;
  summary: string;
  decisions: Array<{ feature_id: string; action: 'include' | 'exclude'; reason: string }>;
  consumed_event_ids: string[];
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
}

export interface RunPmError {
  ok: false;
  error: string;
  detail?: string;
}

interface ParsedOutput {
  decisions: Array<{ feature_id: string; action: 'include' | 'exclude'; reason: string }>;
  spec: string | 'NO_CHANGE';
  summary: string;
}

function parsePmOutput(stdout: string): ParsedOutput | { error: string } {
  // Find the three section markers; the body is everything between them.
  const decisionsMarker = stdout.indexOf('PROJECT_MANAGER_DECISIONS');
  const specMarker = stdout.indexOf('PROJECT_MANAGER_SPEC');
  const summaryMarker = stdout.indexOf('PROJECT_MANAGER_SUMMARY');
  if (decisionsMarker < 0 || specMarker < 0 || summaryMarker < 0) {
    return { error: 'PM output missing one or more required section markers' };
  }
  const decisionsRaw = stdout.slice(decisionsMarker, specMarker).replace(/^PROJECT_MANAGER_DECISIONS\s*/, '').replace(/---\s*$/, '').trim();
  const specRaw = stdout.slice(specMarker, summaryMarker).replace(/^PROJECT_MANAGER_SPEC\s*/, '').replace(/---\s*$/, '').trim();
  const summaryRaw = stdout.slice(summaryMarker).replace(/^PROJECT_MANAGER_SUMMARY\s*/, '').trim();

  let decisions: ParsedOutput['decisions'];
  try {
    const parsed = JSON.parse(decisionsRaw);
    if (!Array.isArray(parsed)) return { error: 'PROJECT_MANAGER_DECISIONS must be a JSON array' };
    decisions = parsed.map((d: any) => ({
      feature_id: String(d.feature_id ?? ''),
      action: d.action === 'include' ? 'include' : 'exclude',
      reason: String(d.reason ?? ''),
    })).filter((d) => d.feature_id);
  } catch (e) {
    return { error: `failed to parse PROJECT_MANAGER_DECISIONS as JSON: ${(e as Error).message}` };
  }

  return {
    decisions,
    spec: specRaw === 'NO_CHANGE' ? 'NO_CHANGE' : specRaw,
    summary: summaryRaw.split('\n')[0]?.trim() || 'PM run',
  };
}

async function tryAcquireProjectLock(db: ReturnType<typeof getLegacyClient>, projectId: string): Promise<boolean> {
  // Advisory lock keyed on a hash of the project id. Single-key lock so we
  // get session-level acquisition without blocking other projects.
  // pg_try_advisory_lock returns true if acquired, false if held elsewhere.
  try {
    const row = (await db.prepare(
      `SELECT pg_try_advisory_lock(hashtext($1))::int AS acquired`,
    ).get(`pm:${projectId}`)) as { acquired: number } | undefined;
    return row?.acquired === 1;
  } catch {
    // If advisory locks aren't available, proceed without lock — best-effort.
    return true;
  }
}

async function releaseProjectLock(db: ReturnType<typeof getLegacyClient>, projectId: string): Promise<void> {
  try {
    await db.prepare(`SELECT pg_advisory_unlock(hashtext($1))`).run(`pm:${projectId}`);
  } catch {
    // ignore
  }
}

export async function runProjectManager(opts: RunPmOptions): Promise<RunPmResult | RunPmError> {
  const { slug, projectId, claudeCmd = process.env.CLAUDE_CMD ?? 'claude', bypassDebounce = false } = opts;
  const db = getLegacyClient(slug);

  // 1. Acquire the per-project advisory lock so concurrent PM runs for the
  // same project serialize.
  const acquired = await tryAcquireProjectLock(db, projectId);
  if (!acquired) {
    return { ok: false, error: 'another PM run is in progress for this project' };
  }

  try {
    // 2. Load the project's current state.
    const project = (await db.prepare(
      'SELECT id, spec, spec_updated_at FROM harness_shared.projects WHERE id = ?',
    ).get(projectId)) as { id: string; spec: string | null; spec_updated_at: string | null } | undefined;
    if (!project) {
      return { ok: false, error: `project not found: ${projectId}` };
    }

    // 3. Find the recently-passed features for this project. "Recent" means
    // since the last project_spec_revision OR (if none) all currently-passed
    // features (the very-first PM run for this project).
    const lastRev = (await db.prepare(
      'SELECT ts FROM harness_shared.project_spec_revisions WHERE project_id = ? AND author_role = $2 ORDER BY ts DESC LIMIT 1',
    ).get(projectId, 'project_manager')) as { ts: string } | undefined;

    const sinceClause = lastRev?.ts
      ? `AND updated_ts > extract(epoch from $2::timestamptz) * 1000`
      : '';
    const featureRows = (await db.prepare(
      `SELECT feature_id, title, status, updated_ts
         FROM harness_features
        WHERE harness_slug = ? AND project_id = $2 AND status = 'passed' ${sinceClause}
        ORDER BY updated_ts DESC LIMIT 20`,
    ).all(slug, projectId, lastRev?.ts ?? '1970-01-01')) as Array<{ feature_id: string; title: string; status: string; updated_ts: number | bigint }>;

    if (featureRows.length === 0 && !bypassDebounce) {
      return {
        ok: true, revision_id: null, changed: false,
        summary: 'No newly-passed features for this project; PM skipped.',
        decisions: [], consumed_event_ids: [], tokens_in: 0, tokens_out: 0, cost_cents: 0,
      };
    }

    const recentFeatureIds = featureRows.map((r) => r.feature_id);

    // 4. Pull pending pm_due events for this project to mark as consumed
    // after we run.
    const pendingEvents = (await db.prepare(
      `SELECT id FROM harness_shared.pending_events
        WHERE install_slug = ? AND kind = 'pm_due' AND consumed_at IS NULL
          AND payload->>'project_id' = $2`,
    ).all(slug, projectId)) as Array<{ id: string }>;
    const eventIds = pendingEvents.map((e) => e.id);

    // 5. Assemble the role prompt.
    const assembled = assembleRolePrompt({
      slug,
      role: 'project_manager',
      mode: 'autonomous',
      extras: [
        `PROJECT_ID=${projectId}`,
        `RECENT_PASSED_FEATURES=${recentFeatureIds.join(',')}`,
      ],
    });

    // 6. Spawn claude. Pipe assembled prompt to stdin; capture stdout.
    const stdout = await spawnClaude(claudeCmd, assembled.text);
    if (!stdout.ok) {
      return { ok: false, error: 'claude invocation failed', detail: stdout.detail };
    }

    // 7. Parse the three-section output.
    const parsed = parsePmOutput(stdout.text);
    if ('error' in parsed) {
      return { ok: false, error: 'PM output unparseable', detail: parsed.error };
    }

    // 8. Persist. Always insert a revision row (even for NO_CHANGE — that's
    // an audit trail of "PM ran and decided nothing changed"). Only update
    // projects.spec when SPEC != NO_CHANGE.
    let revisionId: number | null = null;
    const changed = parsed.spec !== 'NO_CHANGE';
    const newSpec = changed ? (parsed.spec as string) : (project.spec ?? '');

    await db.transaction(async (tx) => {
      const insRow = (await tx.prepare(`
        INSERT INTO harness_shared.project_spec_revisions
          (project_id, spec, summary, author_role, include_decisions)
        VALUES (?, ?, ?, 'project_manager', ?::jsonb)
        RETURNING id
      `).get(projectId, newSpec, parsed.summary, JSON.stringify(parsed.decisions))) as { id: number | bigint };
      revisionId = typeof insRow.id === 'bigint' ? Number(insRow.id) : insRow.id;

      if (changed) {
        await tx.prepare(`
          UPDATE harness_shared.projects
             SET spec = ?, spec_updated_at = now(), updated_ts = ?
           WHERE id = $3
        `).run(newSpec, Date.now(), projectId);
      }

      // Mark consumed pm_due events.
      if (eventIds.length > 0) {
        await tx.prepare(`
          UPDATE harness_shared.pending_events
             SET consumed_at = now(),
                 consumed_by = 'project_manager:' || ?
           WHERE id = ANY($2::text[])
        `).run(`pm-${revisionId}`, eventIds);
      }
    })();

    return {
      ok: true,
      revision_id: revisionId,
      changed,
      summary: parsed.summary,
      decisions: parsed.decisions,
      consumed_event_ids: eventIds,
      // Cost/token accounting is not yet wired — the spawnClaude wrapper
      // returns plain text. A follow-up can parse stream-json events to
      // get actual numbers; for now zeros.
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
    };
  } finally {
    await releaseProjectLock(db, projectId);
  }
}

interface SpawnSuccess { ok: true; text: string }
interface SpawnFailure { ok: false; detail: string }

async function spawnClaude(claudeCmd: string, promptText: string): Promise<SpawnSuccess | SpawnFailure> {
  return await new Promise((resolve) => {
    const argv = claudeCmd.split(/\s+/).filter(Boolean);
    const exe = argv[0] ?? 'claude';
    const baseArgs = argv.slice(1);
    // Plain text output — easier to parse the three-section format. We
    // give up live streaming + cost accounting; caller can switch to
    // stream-json if needed.
    const args = [...baseArgs, '-p'];
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (b: Buffer) => { stdoutBuf += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderrBuf += b.toString('utf8'); });
    child.on('error', (err) => resolve({ ok: false, detail: `spawn error: ${err.message}` }));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true, text: stdoutBuf });
      } else {
        resolve({ ok: false, detail: `claude exit=${code} stderr=${stderrBuf.slice(-500)}` });
      }
    });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}
