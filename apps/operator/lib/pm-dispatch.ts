/**
 * Project Manager dispatch — spawn the agent CLI (omp -p default via
 * Meridian, claude -p when AGENT_BACKEND=claude-code) with the PM role
 * prompt for a specific project, parse the three-section output, persist
 * the new spec revision, and mark consumed pm_due events.
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
import { getLegacyClient, withWorkspaceLegacy } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { projectDirForSlug } from './operator-notes';
import { resolveBackend, resolveAgentBin } from '@restart/papercup-shared/agent';
import { applyToProcessEnv, readAgentConfig } from './agent-config';

export interface RunPmOptions {
  slug: string;
  projectId: string;
  /**
   * Override the agent CLI command. When omitted, resolves via
   * `resolveBackend()` + `resolveAgentBin()` from `@restart/papercup-shared/agent`
   * — the same path runAgentChat uses — so the persisted settings
   * file's `backend` choice (claude-code vs omp) is honored. Without
   * this routing, pm-dispatch would only read AGENT_CMD env and silently
   * default to omp when the user picked claude-code in settings but
   * left `cmd` blank.
   */
  agentCmd?: string;
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
  // Strip a single outer markdown code fence if the model wrapped the
  // entire three-section output (or part of it) in ```...``` — common when
  // the model is mid-conversation and considers the output a "code block".
  let text = stdout.replace(/^[\s\S]*?```(?:[a-z]*)?\n/, (m) => {
    // Only strip if it looks like the fence opens before the first marker.
    return m.includes('PROJECT_MANAGER_') ? m : m;
  });
  // Permissive marker scan: the model occasionally wraps the markers in
  // **bold**, ## headers, or markdown code fences. Match the marker name
  // alone on its own line (with optional decorations).
  const findMarker = (name: string): number => {
    const patterns = [
      new RegExp('^\\s*#{0,3}\\s*\\*{0,2}' + name + '\\*{0,2}:?\\s*$', 'm'),
      new RegExp('^\\s*' + name + '\\s*$', 'm'),
    ];
    let earliest = -1;
    for (const p of patterns) {
      const m = p.exec(text);
      if (m && (earliest < 0 || m.index < earliest)) earliest = m.index;
    }
    return earliest;
  };
  const decisionsMarker = findMarker('PROJECT_MANAGER_DECISIONS');
  const specMarker = findMarker('PROJECT_MANAGER_SPEC');
  const summaryMarker = findMarker('PROJECT_MANAGER_SUMMARY');
  if (decisionsMarker < 0 || specMarker < 0 || summaryMarker < 0) {
    return { error: 'PM output missing one or more required section markers (decisions=' + decisionsMarker + ', spec=' + specMarker + ', summary=' + summaryMarker + ')' };
  }
  const stripMarker = (s: string, name: string): string => {
    return s
      .replace(new RegExp('^\\s*#{0,3}\\s*\\*{0,2}' + name + '\\*{0,2}:?\\s*\\n?'), '')
      .replace(/\n\s*---\s*\n?$/, '')
      .replace(/^\s*```(?:[a-z]*)?\s*\n/, '')
      .replace(/\n\s*```\s*$/, '')
      .trim();
  };
  const decisionsRaw = stripMarker(text.slice(decisionsMarker, specMarker), 'PROJECT_MANAGER_DECISIONS');
  const specRaw = stripMarker(text.slice(specMarker, summaryMarker), 'PROJECT_MANAGER_SPEC');
  // Summary section ends at the first closing fence or end-of-text.
  const summarySection = text.slice(summaryMarker);
  const fenceClose = summarySection.search(/\n\s*```/);
  const summaryRaw = stripMarker(fenceClose >= 0 ? summarySection.slice(0, fenceClose) : summarySection, 'PROJECT_MANAGER_SUMMARY');

  let decisions: ParsedOutput['decisions'];
  try {
    const parsed = JSON.parse(decisionsRaw);
    if (!Array.isArray(parsed)) return { error: 'PROJECT_MANAGER_DECISIONS must be a JSON array' };
    decisions = parsed.map((d: any) => ({
      feature_id: String(d.feature_id ?? ''),
      action: (d.action === 'include' ? 'include' : 'exclude') as 'include' | 'exclude',
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

/**
 * Resolve which agent CLI to spawn for PM dispatches. Single source of
 * truth with chat-stream's runAgentChat: read the persisted agent-config
 * settings (so /settings/agent → backend selection is honored), then
 * defer to resolveBackend + resolveAgentBin. Without this, pm-dispatch
 * would only read AGENT_CMD env and miss the settings-file-driven
 * AGENT_BACKEND=claude-code case (where the user picked claude-code but
 * left cmd blank — chat-stream uses claude, pm-dispatch would have used omp).
 */
async function resolvePmAgentCmdAsync(override?: string): Promise<string> {
  if (override && override.trim()) return override;
  try { applyToProcessEnv(await readAgentConfig()); } catch { /* config absent → env defaults stand */ }
  // Minimal options shape — neither helper reads anything but
  // .backend / .agentCmd from it.
  const stub = {} as Parameters<typeof resolveBackend>[0];
  const backend = resolveBackend(stub);
  return resolveAgentBin(stub, backend);
}

async function releaseProjectLock(db: ReturnType<typeof getLegacyClient>, projectId: string): Promise<void> {
  try {
    await db.prepare(`SELECT pg_advisory_unlock(hashtext($1))`).run(`pm:${projectId}`);
  } catch {
    // ignore
  }
}

export async function runProjectManager(opts: RunPmOptions): Promise<RunPmResult | RunPmError> {
  const { slug, projectId, bypassDebounce = false } = opts;
  const agentCmd = await resolvePmAgentCmdAsync(opts.agentCmd);
  // Wrap the entire PM run in a workspace-scoped tx so harness_shared.*
  // queries pass RLS predicates. Note: the advisory lock + sub-transactions
  // run within this outer transaction. claude spawn happens inside but PG
  // operations after the spawn must still be inside the transaction window.
  return withWorkspaceLegacy(slug, activeWorkspaceId(), async (db) => {
    return await runProjectManagerInner(opts, db);
  });
}

async function runProjectManagerInner(
  opts: RunPmOptions,
  db: ReturnType<typeof getLegacyClient>,
): Promise<RunPmResult | RunPmError> {
  const { slug, projectId, bypassDebounce = false } = opts;
  // Same resolution as runProjectManager — defaults to omp and honors
  // AGENT_BACKEND=claude-code from /settings/agent.
  const agentCmd = await resolvePmAgentCmdAsync(opts.agentCmd);

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
      'SELECT ts FROM harness_shared.project_spec_revisions WHERE project_id = ? AND author_role = ? ORDER BY ts DESC LIMIT 1',
    ).get(projectId, 'project_manager')) as { ts: string } | undefined;

    const featureRows = lastRev?.ts
      ? (await db.prepare(
          `SELECT feature_id, title, status, updated_ts
             FROM harness_features
            WHERE harness_slug = ? AND project_id = ? AND status = 'passed'
              AND updated_ts > extract(epoch from ?::timestamptz) * 1000
            ORDER BY updated_ts DESC LIMIT 20`,
        ).all(slug, projectId, lastRev.ts)) as Array<{ feature_id: string; title: string; status: string; updated_ts: number | bigint }>
      : (await db.prepare(
          `SELECT feature_id, title, status, updated_ts
             FROM harness_features
            WHERE harness_slug = ? AND project_id = ? AND status = 'passed'
            ORDER BY updated_ts DESC LIMIT 20`,
        ).all(slug, projectId)) as Array<{ feature_id: string; title: string; status: string; updated_ts: number | bigint }>;

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
          AND payload->>'project_id' = ?`,
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

    // 6. Spawn claude with cwd set to the harness project directory so its
    // session-scoped path restriction allows reading harness state, feature
    // docs, .harness/memory/, etc. Without this, claude is locked to the
    // dev-server's cwd and cannot read any of the inputs the PM prompt
    // tells it to look at.
    const projectDir = projectDirForSlug(slug);
    const spawned = await spawnClaude(agentCmd, assembled.text, projectDir ?? undefined);
    if (!spawned.ok) {
      return { ok: false, error: 'claude invocation failed', detail: spawned.detail };
    }

    // 7. Parse the three-section output.
    const parsed = parsePmOutput(spawned.text);
    if ('error' in parsed) {
      // Persist raw output so we can inspect parse failures without log scraping.
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join('/tmp', 'papercusp-pm-debug');
        fs.mkdirSync(dir, { recursive: true });
        const fname = path.join(dir, slug + '-' + projectId + '-' + Date.now() + '.txt');
        fs.writeFileSync(fname, spawned.text);
        return { ok: false, error: 'PM output unparseable', detail: parsed.error + ' (raw saved to ' + fname + ')' };
      } catch {
        return { ok: false, error: 'PM output unparseable', detail: parsed.error };
      }
    }
    const costCents = Math.round(spawned.cost_usd * 100);

    // 8. Persist. Always insert a revision row (even for NO_CHANGE — that's
    // an audit trail of "PM ran and decided nothing changed"). Only update
    // projects.spec when SPEC != NO_CHANGE.
    let revisionId: number | null = null;
    const changed = parsed.spec !== 'NO_CHANGE';
    const newSpec = changed ? (parsed.spec as string) : (project.spec ?? '');

    await db.transaction(async (tx) => {
      const insRow = (await tx.prepare(`
        INSERT INTO harness_shared.project_spec_revisions
          (project_id, spec, summary, author_role, include_decisions, tokens_in, tokens_out, cost_usd_cents)
        VALUES (?, ?, ?, 'project_manager', ?::jsonb, ?, ?, ?)
        RETURNING id
      `).get(
        projectId, newSpec, parsed.summary, JSON.stringify(parsed.decisions),
        spawned.tokens_in, spawned.tokens_out, costCents,
      )) as { id: number | bigint };
      revisionId = typeof insRow.id === 'bigint' ? Number(insRow.id) : insRow.id;

      if (changed) {
        await tx.prepare(`
          UPDATE harness_shared.projects
             SET spec = ?, spec_updated_at = now(), updated_ts = ?
           WHERE id = ?
        `).run(newSpec, Date.now(), projectId);
      }

      // Mark consumed pm_due events.
      if (eventIds.length > 0) {
        await tx.prepare(`
          UPDATE harness_shared.pending_events
             SET consumed_at = now(),
                 consumed_by = 'project_manager:' || ?
           WHERE id = ANY(?::text[])
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
      tokens_in: spawned.tokens_in,
      tokens_out: spawned.tokens_out,
      cost_cents: costCents,
    };
  } finally {
    await releaseProjectLock(db, projectId);
  }
}

interface SpawnSuccess {
  ok: true;
  /** The model's final text output. Prefers the `result` event when present;
   * falls back to accumulated text_delta events when the stream ends without
   * a result event (e.g. claude hit a tool-use limit before completing). */
  text: string;
  /** Aggregated usage from the stream's `result` event; zeros if unavailable. */
  tokens_in: number;
  tokens_out: number;
  /** Total cost in USD (NOT cents) — caller multiplies by 100 + rounds to store as cents. */
  cost_usd: number;
}
interface SpawnFailure { ok: false; detail: string }

/**
 * Spawn claude with stream-json output and parse the terminal `result`
 * event for usage + cost. We use stream-json instead of plain text because
 * (a) it carries token counts and cost on the result event so we can
 * persist real numbers on `project_spec_revisions`, and (b) the result
 * event's `result` field is the canonical final assistant text — robust
 * against partial-message fragments at end-of-stream.
 *
 * If no `result` event arrives (e.g. claude exits early), we fall back to
 * the assistant text we accumulated from text_delta events. That gives the
 * parser something useful to work with even on aborted runs.
 */
async function spawnClaude(agentCmd: string, promptText: string, cwd?: string): Promise<SpawnSuccess | SpawnFailure> {
  return await new Promise((resolve) => {
    const argv = agentCmd.split(/\s+/).filter(Boolean);
    const exe = argv[0] ?? 'omp';
    const baseArgs = argv.slice(1);

    // Backend-aware flag set. pm-dispatch was originally claude-only;
    // post-omp-default flip, it must emit the right structured-stream
    // flags per CLI:
    //   - claude: --output-format stream-json --verbose --include-partial-messages
    //   - omp:    --mode json --no-session
    // omp also reads the prompt from a positional `@file` argument
    // rather than stdin (its `-p` mode doesn't accept stdin), so we
    // route the prompt via tmpfile when backend=omp.
    const isOmp = /(?:^|\/)(omp|pi)$/.test(exe);
    const alreadyStructured = argv.some((a) => a.includes('stream-json') || a === '--mode');
    // Substrate-level authorization: PM produces structured text output
    // (the three-section format that's parsed and written to project_spec_revisions);
    // it has no business writing files directly. Disallow Edit/Write/Create
    // tools so the PM agent physically cannot mutate SPEC.md, the worktree,
    // or anything else even if its prompt rule is forgotten or overridden.
    // Read/Grep/Glob/Bash remain available for context discovery.
    const denyToolFlags = ['--disallowed-tools', 'Edit Write Create MultiEdit NotebookEdit'];

    let promptFilePath: string | null = null;
    let args: string[];
    if (isOmp) {
      // Write prompt to tmp file, append @file. omp's -p reads positional
      // arg, not stdin, so child.stdin.write would silently drop the prompt.
      const { writeFileSync, mkdtempSync } = require('node:fs');
      const { join } = require('node:path');
      const { tmpdir } = require('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pm-dispatch-'));
      promptFilePath = join(tmpDir, 'prompt.md');
      writeFileSync(promptFilePath, promptText, 'utf8');
      const structFlags = alreadyStructured ? [] : ['--mode', 'json', '--no-session'];
      args = [...baseArgs, '-p', ...structFlags, ...denyToolFlags, `@${promptFilePath}`];
    } else {
      // claude-code path. Stream-json flags only if not already configured.
      const structFlags = alreadyStructured
        ? []
        : ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
      args = [...baseArgs, '-p', ...structFlags, ...denyToolFlags];
    }

    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let stderrBuf = '';
    let lineBuf = '';
    let resultText = '';
    let assistantText = '';   // accumulated from text_delta events as fallback
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let nl: number;
      // eslint-disable-next-line no-cond-assign
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line || !line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (isOmp) {
            // omp event shapes:
            //   - turn_end / message_end with role:'assistant' carries the
            //     final text + cumulative usage + cost.
            //   - message_update with text_delta carries assistant deltas.
            if ((ev.type === 'turn_end' || ev.type === 'message_end') && ev.message?.role === 'assistant') {
              const content = Array.isArray(ev.message.content) ? ev.message.content : [];
              const textPart = content.find((c: any) => c?.type === 'text');
              if (textPart && typeof textPart.text === 'string') resultText = textPart.text;
              const usage = ev.message.usage;
              if (usage) {
                tokensIn = usage.input ?? tokensIn;
                tokensOut = usage.output ?? tokensOut;
                if (usage.cost && typeof usage.cost.total === 'number') costUsd = usage.cost.total;
              }
            } else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
              assistantText += ev.assistantMessageEvent.delta ?? '';
            }
          } else {
            // claude-code event shapes (legacy stream-json).
            if (ev.type === 'result') {
              if (typeof ev.result === 'string') resultText = ev.result;
              if (ev.usage) {
                tokensIn = ev.usage.input_tokens ?? tokensIn;
                tokensOut = ev.usage.output_tokens ?? tokensOut;
              }
              if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
            } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta'
                       && ev.event?.delta?.type === 'text_delta') {
              assistantText += ev.event.delta.text ?? '';
            }
          }
        } catch { /* malformed line — skip */ }
      }
    });
    child.stderr.on('data', (b: Buffer) => { stderrBuf += b.toString('utf8'); });
    const cleanup = () => {
      // omp prompt tmpfile cleanup. Best-effort; harmless if it fails.
      if (promptFilePath) {
        try { require('node:fs').unlinkSync(promptFilePath); } catch { /* ignore */ }
      }
    };
    child.on('error', (err) => { cleanup(); resolve({ ok: false, detail: `spawn error: ${err.message}` }); });
    child.on('exit', (code) => {
      cleanup();
      if (code === 0) {
        resolve({
          ok: true,
          text: resultText || assistantText,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: costUsd,
        });
      } else {
        resolve({ ok: false, detail: `${exe} exit=${code} stderr=${stderrBuf.slice(-500)}` });
      }
    });
    if (isOmp) {
      // omp reads the prompt from the @file positional we appended; close
      // stdin so the child doesn't block on a TTY check.
      try { child.stdin.end(); } catch { /* ignore */ }
    } else {
      // claude-code: prompt over stdin.
      child.stdin.write(promptText);
      child.stdin.end();
    }
  });
}
