/**
 * Papercup org API. File-backed, consistent with the harness module's approach.
 *
 * Sources of truth:
 *   ~/.restart-org/charter.md           — org charter (markdown)
 *   ~/.restart-org/departments.json     — fixed 5 departments
 *   ~/.restart-org/projects.json        — project registry
 *   ~/.restart-org/messages.jsonl       — append-only message log
 *
 * Materialized views (rebuilt on every write to messages.jsonl):
 *   ~/org-{dept}/.harness/inbox-view.jsonl
 *   ~/org-{dept}/.harness/outbox-view.jsonl
 */
import { Hono } from 'hono';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getLegacyClient } from '@restart/db-org';
const getOrgDbClient = () => getLegacyClient();

const ORG_ROOT = join(homedir(), '.restart-org');
const CHARTER_PATH = join(ORG_ROOT, 'charter.md');
const MISSION_PATH = join(ORG_ROOT, 'mission.md');
const DEPARTMENTS_PATH = join(ORG_ROOT, 'departments.json');
const PROJECTS_PATH = join(ORG_ROOT, 'projects.json');
const MESSAGES_PATH = join(ORG_ROOT, 'messages.jsonl');
const DIRECTIVES_PATH = join(ORG_ROOT, 'directives.json');
const DIRECTIVE_SUMMARIES_PATH = join(ORG_ROOT, 'directive-summaries.jsonl');
const AUDIT_LOG_PATH = join(ORG_ROOT, 'audit.jsonl');
const COMMENTS_PATH = join(ORG_ROOT, 'message-comments.jsonl');
const SECRETS_DIR = join(ORG_ROOT, 'secrets');

type Department = {
  slug: string;
  harnessSlug: string;
  name: string;
  // Layer 3-C: mandate, inboxKinds, outboxKinds, allowedActions moved to per-harness
  // config.json (read via getDeptRoleConfig). departments.json is now a thin registry.
  // The optional fields below are kept for backward-compat with code that hasn't migrated yet.
  mandate?: string;
  inboxKinds?: string[];
  outboxKinds?: string[];
  allowedActions?: string[];
};

type Project = {
  id: string;
  slug: string;
  name: string;
  vertical: string;
  status: 'proposed' | 'approved' | 'in_progress' | 'launched' | 'paused' | 'cancelled';
  owning_director: string;
  budget_cents: number;
  spent_cents: number;
  earned_cents?: number;
  cost_cap_cents?: number;
  created_ts: number;
  metadata?: Record<string, unknown>;
};

type MessageStatus = 'pending' | 'acknowledged' | 'actioned' | 'archived';

type Message = {
  id: string;
  ts: number;
  from: string;
  to: string[];
  kind: string;
  subject: string;
  body: string;
  refId?: string;
  projectId?: string;
  directiveId?: string;
  status: MessageStatus;
  metadata?: Record<string, unknown>;
};

// Reserved project ids for cross-cutting work
const PROJECT_PLATFORM = 'platform-reserved';
const PROJECT_ORG_OPS = 'org-ops-reserved';

type DirectiveStatus = 'active' | 'paused' | 'complete' | 'cancelled';

type Directive = {
  id: string;
  title: string;
  body: string;
  status: DirectiveStatus;
  created_by: string;
  created_ts: number;
  deadline_ts?: number;
  budget_cents?: number;
  priority?: 'low' | 'normal' | 'high';
  assignedDepartments?: string[];
  linkedProjectIds?: string[];
};

type DirectiveSummary = {
  id: string;
  directiveId: string;
  ts: number;
  author: 'ceo' | 'user';
  body: string;
  linkedMessageIds?: string[];
};

type AuditEntry = {
  id: string;
  ts: number;
  actor: string;        // 'user' for now; future: per-user identity
  action: string;       // 'charter.edit' | 'director-config.edit' | 'project.delete' | 'directive.status' | 'admin.stop-all'
  subject: string;      // identifier (slug, id, or 'org')
  details?: Record<string, unknown>;
};

type MessageComment = {
  id: string;
  messageId: string;
  ts: number;
  author: string;       // 'user' for now
  body: string;
};

function loadDepartments(): Department[] {
  if (!existsSync(DEPARTMENTS_PATH)) return [];
  const raw = readFileSync(DEPARTMENTS_PATH, 'utf8');
  return JSON.parse(raw).departments as Department[];
}

/**
 * Layer 2-B: read role-permissions from per-harness config.json,
 * falling back to departments.json. This is the single source of truth
 * for outboxKinds/inboxKinds/allowedActions during the dual-config
 * transition. After Layer 3 slims departments.json, this only reads
 * per-harness config.
 */
function getDeptRoleConfig(deptSlug: string, role = 'director'): {
  inboxKinds: string[];
  outboxKinds: string[];
  allowedActions: string[];
  mandate?: string;
} | null {
  const dept = loadDepartments().find((d) => d.slug === deptSlug);
  if (!dept) return null;
  const cfgPath = join(homedir(), dept.harnessSlug, '.harness', 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const roleCfg = cfg?.roles?.[role];
      if (roleCfg && Array.isArray(roleCfg.outboxKinds) && Array.isArray(roleCfg.inboxKinds)) {
        return {
          inboxKinds: roleCfg.inboxKinds,
          outboxKinds: roleCfg.outboxKinds,
          allowedActions: roleCfg.allowedActions ?? dept.allowedActions ?? [],
          mandate: roleCfg.mandate ?? dept.mandate,
        };
      }
    } catch { /* fall through to departments.json */ }
  }
  return {
    inboxKinds: dept.inboxKinds ?? [],
    outboxKinds: dept.outboxKinds ?? [],
    allowedActions: dept.allowedActions ?? [],
    mandate: dept.mandate,
  };
}

function loadProjects(): Project[] {
  if (!existsSync(PROJECTS_PATH)) return [];
  const raw = readFileSync(PROJECTS_PATH, 'utf8');
  return JSON.parse(raw).projects as Project[];
}

async function saveProjects(projects: Project[]): Promise<void> {
  await mkdir(ORG_ROOT, { recursive: true });
  await writeFile(PROJECTS_PATH, JSON.stringify({ version: 1, projects }, null, 2));
}

function loadMessages(): Message[] {
  if (!existsSync(MESSAGES_PATH)) return [];
  const raw = readFileSync(MESSAGES_PATH, 'utf8');
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Message);
}

async function saveMessagesRebuild(messages: Message[]): Promise<void> {
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
  await writeFile(MESSAGES_PATH, content);
  await rebuildInboxOutboxViews(messages);
}

async function appendMessage(m: Message): Promise<void> {
  // Layer 1.5: dual-write to SQL alongside JSONL.
  // SQL is the future canonical store; JSONL is preserved during the
  // transition for rollback safety + per-dept inbox-view.jsonl projections
  // that existing dept agent prompts still read.
  // Both writes happen, but JSONL is authoritative for read paths until
  // Layer 2 flips the default. SQL write failure is logged but non-fatal
  // (we never want to lose a JSONL write because SQL had a hiccup).
  await appendFile(MESSAGES_PATH, JSON.stringify(m) + '\n');
  try {
    const c = getOrgDbClient();
    await c.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO messages
        (id, ts, from_dept, kind, subject, body, ref_id, project_id, directive_id, status, metadata)
        VALUES (@id, @ts, @from_dept, @kind, @subject, @body, @ref_id, @project_id, @directive_id, @status, @metadata)
        ON CONFLICT (id) DO NOTHING`).run({
        id: m.id,
        ts: m.ts,
        from_dept: m.from,
        kind: m.kind,
        subject: m.subject ?? '',
        body: m.body ?? '',
        ref_id: m.refId ?? null,
        project_id: m.projectId ?? null,
        directive_id: m.directiveId ?? null,
        status: m.status ?? 'pending',
        metadata: m.metadata == null ? null : JSON.stringify(m.metadata),
      });
      for (const dept of (m.to ?? [])) {
        await tx.prepare('INSERT INTO message_recipients (message_id, dept_slug) VALUES (?, ?) ON CONFLICT DO NOTHING').run(m.id, dept);
      }
    })();
  } catch (e) {
    // Don't block writes if SQL is unavailable (e.g. test fixtures with
    // RESTART_ORG_ROOT pointing somewhere else). Log and continue.
    console.warn('[org dual-write] SQL insert failed:', (e as Error)?.message);
  }
  const all = loadMessages();
  await rebuildInboxOutboxViews(all);
  // Side effects on certain message kinds (charter-driven automation)
  await applyMessageSideEffects(m);
}

async function applyMessageSideEffects(m: Message): Promise<void> {
  // Capability fan-out: when Technology emits a Capability, attach a CC trace
  // entry on each active project's metadata so Project detail surfaces it.
  if (m.kind === 'Capability' && m.from === 'technology') {
    const projects = loadProjects();
    let mutated = false;
    for (const p of projects) {
      if (p.status === 'cancelled' || p.metadata?.reserved) continue;
      const md = (p.metadata ?? {}) as Record<string, any>;
      md.capabilitiesAvailable = (md.capabilitiesAvailable ?? 0) + 1;
      md.lastCapability = { ts: m.ts, subject: m.subject, messageId: m.id };
      p.metadata = md;
      mutated = true;
    }
    if (mutated) await saveProjects(projects);
  }
  // Capability deprecation: when Technology emits a CapabilityDeprecation
  // (refId points at original Capability), decrement counters on every project
  // and record that this capability is now deprecated.
  if (m.kind === 'CapabilityDeprecation' && m.from === 'technology') {
    const projects = loadProjects();
    let mutated = false;
    for (const p of projects) {
      if (p.status === 'cancelled' || p.metadata?.reserved) continue;
      const md = (p.metadata ?? {}) as Record<string, any>;
      md.capabilitiesAvailable = Math.max(0, (md.capabilitiesAvailable ?? 0) - 1);
      const deprecated = (md.deprecatedCapabilities ?? []) as Array<{ ts: number; subject: string; messageId: string; refId?: string }>;
      deprecated.push({ ts: m.ts, subject: m.subject, messageId: m.id, refId: m.refId });
      md.deprecatedCapabilities = deprecated;
      p.metadata = md;
      mutated = true;
    }
    if (mutated) await saveProjects(projects);
  }
  // ProgressUpdate with metadata.statusUpdate advances the project's status.
  // Lets Management drive project state via messaging without a separate PATCH.
  if (m.kind === 'ProgressUpdate' && m.from === 'management' && m.projectId) {
    const newStatus = (m.metadata as any)?.statusUpdate;
    const validStatuses = ['proposed', 'approved', 'in_progress', 'launched', 'paused', 'cancelled'];
    if (typeof newStatus === 'string' && validStatuses.includes(newStatus)) {
      const projects = loadProjects();
      const idx = projects.findIndex((p) => p.id === m.projectId);
      if (idx !== -1 && !projects[idx].metadata?.reserved) {
        projects[idx] = { ...projects[idx], status: newStatus as Project['status'] };
        await saveProjects(projects);
      }
    }
  }
  // Budget enforcement: BudgetAllocation with projectId+amount_cents updates the project's budget_cents.
  if (m.kind === 'BudgetAllocation' && m.projectId) {
    const amt = (m.metadata as any)?.amount_cents;
    if (typeof amt === 'number' && amt > 0) {
      const projects = loadProjects();
      const idx = projects.findIndex((p) => p.id === m.projectId);
      if (idx !== -1 && !projects[idx].metadata?.reserved) {
        projects[idx] = {
          ...projects[idx],
          // Budget allocations accumulate (multiple allocations to same project).
          budget_cents: (projects[idx].budget_cents ?? 0) + amt,
        };
        await saveProjects(projects);
      }
    }
  }
}

async function rebuildInboxOutboxViews(messages: Message[]): Promise<void> {
  const depts = loadDepartments();
  for (const d of depts) {
    const harnessDir = join(homedir(), d.harnessSlug, '.harness');
    const inboxPath = join(harnessDir, 'inbox-view.jsonl');
    const outboxPath = join(harnessDir, 'outbox-view.jsonl');
    const supervisorNotesPath = join(harnessDir, 'supervisor-notes.md');
    const inbox = messages.filter((m) => m.to.includes(d.slug));
    const outbox = messages.filter((m) => m.from === d.slug);
    try {
      await writeFile(inboxPath, inbox.map((m) => JSON.stringify(m)).join('\n') + (inbox.length ? '\n' : ''));
      await writeFile(outboxPath, outbox.map((m) => JSON.stringify(m)).join('\n') + (outbox.length ? '\n' : ''));
      // Layer 2-A: render supervisor-notes.md as a markdown view of the SQL-
      // backed inbox. Newest first. Fully regenerable; no cursor file.
      const blocks = inbox
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .map((m) => {
          const tsIso = new Date(m.ts).toISOString();
          const refLine = m.refId ? `\nrefId: ${m.refId}` : '';
          return `## ${m.kind} ${tsIso}\nfrom: ${m.from}${refLine}\nstatus: ${m.status}\n\n**${m.subject}**\n\n${m.body}`;
        });
      const md = `# Supervisor notes for ${d.slug}\n\nProjected from messages bus at ${new Date().toISOString()}.\nNewest first. Fully regenerable — do not hand-edit; use \`POST /api/org/messages\` instead.\n\n${blocks.join('\n\n---\n\n')}\n`;
      await writeFile(supervisorNotesPath, md);
    } catch {
      // Department harness dir may not exist yet; skip silently
    }
  }
}

export const org = new Hono();

// -------- Charter --------
org.get('/charter', async (c) => {
  if (!existsSync(CHARTER_PATH)) return c.text('', 404);
  const content = await readFile(CHARTER_PATH, 'utf8');
  return c.text(content);
});

org.put('/charter', async (c) => {
  const body = await c.req.text();
  if (!body || body.length < 100) return c.json({ error: 'charter must be at least 100 chars' }, 400);
  await mkdir(ORG_ROOT, { recursive: true });
  const oldLen = existsSync(CHARTER_PATH) ? readFileSync(CHARTER_PATH, 'utf8').length : 0;
  await writeFile(CHARTER_PATH, body);
  await appendAudit('charter.edit', 'org', { fromLength: oldLen, toLength: body.length });
  return c.json({ ok: true, charLength: body.length });
});

// -------- Mission (org north-star, injected into every dept prompt) --------
org.get('/mission', async (c) => {
  if (!existsSync(MISSION_PATH)) return c.text('', 404);
  const content = await readFile(MISSION_PATH, 'utf8');
  return c.text(content);
});

org.put('/mission', async (c) => {
  const body = await c.req.text();
  if (!body || body.length < 10) return c.json({ error: 'mission must be at least 10 chars' }, 400);
  await mkdir(ORG_ROOT, { recursive: true });
  const oldLen = existsSync(MISSION_PATH) ? readFileSync(MISSION_PATH, 'utf8').length : 0;
  await writeFile(MISSION_PATH, body);
  await appendAudit('mission.edit', 'org', { fromLength: oldLen, toLength: body.length });
  return c.json({ ok: true, charLength: body.length });
});

// -------- Per-department director-config (auto-loop interval, etc.) --------
org.get('/:dept/director-config', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const path = join(homedir(), dept.harnessSlug, '.harness', 'director-config.json');
  if (!existsSync(path)) return c.json({});
  try {
    const raw = await readFile(path, 'utf8');
    return c.json(JSON.parse(raw || '{}'));
  } catch {
    return c.json({});
  }
});

org.put('/:dept/director-config', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const path = join(homedir(), dept.harnessSlug, '.harness', 'director-config.json');
  await writeFile(path, JSON.stringify(body, null, 2));
  await appendAudit('director-config.edit', slug, { config: body });
  return c.json({ ok: true, config: body });
});

// ================================================================
// Server-side auto-loop scheduler. Runs even when no browser is open.
// ================================================================

type Scheduler = { timeout: ReturnType<typeof setTimeout>; intervalSeconds: number; scheduledFor: number; lastRunAt: number | null };






// (Legacy spawnClaude pipeline + scheduler infrastructure removed in Layer 3-A.
// Department directors are now invoked via POST /api/harness/org-<slug>/invoke?role=director.)


// -------- Departments --------
org.get('/departments', (c) => {
  const depts = loadDepartments();
  const messages = loadMessages();
  const withCounts = depts.map((d) => {
    const inboxAll = messages.filter((m) => m.to.includes(d.slug));
    const inboxPending = inboxAll.filter((m) => m.status === 'pending').length;
    const outboxAll = messages.filter((m) => m.from === d.slug);
    const lastActivity = [...inboxAll, ...outboxAll]
      .map((m) => m.ts)
      .sort((a, b) => b - a)[0];
    // Read auto-loop config
    let autoLoop = false;
    let autoIntervalSeconds = 60;
    try {
      const cfgPath = join(homedir(), d.harnessSlug, '.harness', 'director-config.json');
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8') || '{}');
        if (typeof cfg.autoLoop === 'boolean') autoLoop = cfg.autoLoop;
        if (typeof cfg.autoIntervalSeconds === 'number') autoIntervalSeconds = cfg.autoIntervalSeconds;
      }
    } catch {}
    // Layer 3-A: legacy spawnClaude pipeline removed; activeRun/scheduler always null.
    // Director invocation now goes through POST /api/harness/org-<slug>/invoke?role=director.
    return {
      ...d,
      counts: {
        inboxTotal: inboxAll.length,
        inboxPending,
        outboxTotal: outboxAll.length,
      },
      lastActivity: lastActivity ?? null,
      autoLoop,
      autoIntervalSeconds,
      activeRun: null,
      scheduler: null,
    };
  });
  return c.json({ departments: withCounts });
});

// -------- Messages --------
org.get('/messages/:id', (c) => {
  const id = c.req.param('id');
  const m = loadMessages().find((x) => x.id === id);
  if (!m) return c.json({ error: 'message not found' }, 404);
  // Find related messages: same refId chain or response refs
  const all = loadMessages();
  const responses = all.filter((x) => x.refId === id);
  const referenced = m.refId ? all.find((x) => x.id === m.refId) : null;
  return c.json({ message: m, responses, referenced });
});

// ─── Layer 1.5: SQL-source read endpoints ──────────────────────────
//
// New endpoints serving inbox/outbox/supervisor-notes from the SQLite
// store at ~/.restart-org/.harness/store.db. Indexed queries (no full-
// file scan), per-recipient routing via message_recipients junction.
//
// Replaces direct reads of ~/org-<slug>/.harness/{inbox,outbox}-view.jsonl.
// Existing endpoints above continue to use loadMessages() (JSONL) during
// the transition; Layer 2 flips read source.

org.get('/inbox', async (c) => {
  const dept = c.req.query('dept');
  const sinceRaw = c.req.query('since');
  const since = sinceRaw ? Number(sinceRaw) : 0;
  if (!dept) return c.json({ error: 'dept query param required' }, 400);
  try {
    const client = getOrgDbClient();
    const rows = await client.prepare(`
      SELECT m.* FROM messages m
      JOIN message_recipients r ON r.message_id = m.id
      WHERE r.dept_slug = ? AND m.ts > ?
      ORDER BY m.ts DESC
    `).all(dept, since) as any[];
    const messages = await Promise.all(rows.map(async (r) => ({
      id: r.id, ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts, from: r.from_dept, kind: r.kind, subject: r.subject,
      body: r.body, refId: r.ref_id, projectId: r.project_id, directiveId: r.directive_id,
      status: r.status, metadata: r.metadata ?? null,
      to: ((await client.prepare('SELECT dept_slug FROM message_recipients WHERE message_id = ?').all(r.id)) as any[]).map((x: any) => x.dept_slug),
    })));
    return c.json({ dept, messages });
  } catch (e) {
    return c.json({ error: `SQL inbox query failed: ${(e as Error).message}` }, 500);
  }
});

org.get('/outbox', async (c) => {
  const dept = c.req.query('dept');
  if (!dept) return c.json({ error: 'dept query param required' }, 400);
  try {
    const client = getOrgDbClient();
    const rows = await client.prepare(`
      SELECT * FROM messages WHERE from_dept = ? ORDER BY ts DESC
    `).all(dept) as any[];
    const messages = await Promise.all(rows.map(async (r) => ({
      id: r.id, ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts, from: r.from_dept, kind: r.kind, subject: r.subject,
      body: r.body, refId: r.ref_id, projectId: r.project_id, directiveId: r.directive_id,
      status: r.status, metadata: r.metadata ?? null,
      to: ((await client.prepare('SELECT dept_slug FROM message_recipients WHERE message_id = ?').all(r.id)) as any[]).map((x: any) => x.dept_slug),
    })));
    return c.json({ dept, messages });
  } catch (e) {
    return c.json({ error: `SQL outbox query failed: ${(e as Error).message}` }, 500);
  }
});

org.get('/supervisor-notes', async (c) => {
  const dept = c.req.query('dept');
  if (!dept) return c.json({ error: 'dept query param required' }, 400);
  try {
    const client = getOrgDbClient();
    const rows = await client.prepare(`
      SELECT m.* FROM messages m
      JOIN message_recipients r ON r.message_id = m.id
      WHERE r.dept_slug = ? ORDER BY m.ts DESC
    `).all(dept) as any[];
    const blocks = rows.map((r) => {
      const tsNum = typeof r.ts === 'bigint' ? Number(r.ts) : r.ts;
      const tsIso = new Date(tsNum).toISOString();
      const refLine = r.ref_id ? `\nrefId: ${r.ref_id}` : '';
      return `## ${r.kind} ${tsIso}\nfrom: ${r.from_dept}${refLine}\nstatus: ${r.status}\n\n**${r.subject}**\n\n${r.body}`;
    });
    const markdown = `# Supervisor notes for ${dept}\n\nProjected from restart_harness Postgres at ${new Date().toISOString()}.\nNewest first.\n\n${blocks.join('\n\n---\n\n')}\n`;
    return c.text(markdown);
  } catch (e) {
    return c.json({ error: `SQL supervisor-notes query failed: ${(e as Error).message}` }, 500);
  }
});

org.get('/messages', (c) => {
  const messages = loadMessages();
  const from = c.req.query('from');
  const to = c.req.query('to');
  const projectId = c.req.query('projectId');
  const kind = c.req.query('kind');
  const status = c.req.query('status');
  const q = c.req.query('q')?.toLowerCase().trim();

  let filtered = messages;
  if (from) filtered = filtered.filter((m) => m.from === from);
  if (to) filtered = filtered.filter((m) => m.to.includes(to));
  if (projectId) filtered = filtered.filter((m) => m.projectId === projectId);
  if (kind) filtered = filtered.filter((m) => m.kind === kind);
  if (status) filtered = filtered.filter((m) => m.status === status);
  if (q) {
    filtered = filtered.filter((m) =>
      m.subject.toLowerCase().includes(q) ||
      m.body.toLowerCase().includes(q) ||
      m.kind.toLowerCase().includes(q) ||
      m.from.toLowerCase().includes(q) ||
      m.to.some((t) => t.toLowerCase().includes(q))
    );
  }

  return c.json({ messages: filtered.sort((a, b) => b.ts - a.ts) });
});

/**
 * Universal search: across messages, directives, projects.
 */
org.get('/search', (c) => {
  const q = c.req.query('q')?.toLowerCase().trim() ?? '';
  if (!q) return c.json({ messages: [], directives: [], projects: [] });

  const messages = loadMessages().filter((m) =>
    m.subject.toLowerCase().includes(q) ||
    m.body.toLowerCase().includes(q) ||
    m.kind.toLowerCase().includes(q)
  ).sort((a, b) => b.ts - a.ts).slice(0, 20);

  const directives = loadDirectives().filter((d) =>
    d.title.toLowerCase().includes(q) ||
    d.body.toLowerCase().includes(q) ||
    d.id.toLowerCase().includes(q)
  ).slice(0, 10);

  const projects = loadProjects().filter((p) =>
    p.name.toLowerCase().includes(q) ||
    p.slug.toLowerCase().includes(q) ||
    p.vertical.toLowerCase().includes(q)
  ).slice(0, 10);

  return c.json({ messages, directives, projects });
});

org.post('/messages', async (c) => {
  const body = await c.req.json<{
    from: string;
    to: string[];
    kind: string;
    subject: string;
    body: string;
    refId?: string;
    projectId?: string;
    directiveId?: string;
    metadata?: Record<string, unknown>;
  }>();

  const depts = loadDepartments();
  const deptSlugs = depts.map((d) => d.slug);

  // Special case: 'user' can only send 'Directive' kind to 'business'
  if (body.from === 'user') {
    if (body.kind !== 'Directive') {
      return c.json({ error: `user can only send 'Directive' kind, got: ${body.kind}` }, 400);
    }
    if (body.to.length !== 1 || body.to[0] !== 'business') {
      return c.json({ error: `Directive must be sent only to 'business'` }, 400);
    }
  } else {
    if (!deptSlugs.includes(body.from)) {
      return c.json({ error: `unknown from department: ${body.from}` }, 400);
    }
    for (const to of body.to) {
      if (!deptSlugs.includes(to)) {
        return c.json({ error: `unknown to department: ${to}` }, 400);
      }
    }
    // Layer 2-B: read outboxKinds from per-harness config (with fallback to departments.json)
    const roleCfg = getDeptRoleConfig(body.from);
    if (!roleCfg) return c.json({ error: `unknown from: ${body.from}` }, 400);
    if (!roleCfg.outboxKinds.includes(body.kind)) {
      return c.json(
        { error: `${body.from} is not permitted to send kind: ${body.kind}. Allowed: ${roleCfg.outboxKinds.join(', ')}` },
        400,
      );
    }
  }

  // Default projectId by message kind for cross-cutting actions:
  //   PlatformUpdate / Capability  → platform
  //   anything else without explicit projectId → org-ops
  // This enforces "all actions live inside a project" while keeping
  // genuinely cross-cutting work in well-known reserved projects.
  let projectId = body.projectId;
  if (!projectId) {
    if (body.kind === 'PlatformUpdate' || body.kind === 'Capability') {
      projectId = PROJECT_PLATFORM;
    } else {
      projectId = PROJECT_ORG_OPS;
    }
  } else {
    // validate the project exists
    const exists = loadProjects().some((p) => p.id === projectId || p.slug === projectId);
    if (!exists) return c.json({ error: `unknown projectId: ${projectId}` }, 400);
    // normalize slug → id for storage consistency
    const proj = loadProjects().find((p) => p.slug === projectId);
    if (proj) projectId = proj.id;
  }

  const message: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: body.from,
    to: body.to,
    kind: body.kind,
    subject: body.subject,
    body: body.body,
    refId: body.refId,
    projectId,
    directiveId: body.directiveId,
    status: 'pending',
    metadata: body.metadata,
  };

  await appendMessage(message);
  return c.json({ message });
});

org.post('/messages/bulk-status', async (c) => {
  const body = await c.req.json<{ messageIds: string[]; status: MessageStatus }>();
  const validStatuses: MessageStatus[] = ['pending', 'acknowledged', 'actioned', 'archived'];
  if (!validStatuses.includes(body.status)) return c.json({ error: `invalid status: ${body.status}` }, 400);
  if (!Array.isArray(body.messageIds) || body.messageIds.length === 0) return c.json({ error: 'messageIds[] required' }, 400);
  const messages = loadMessages();
  const idSet = new Set(body.messageIds);
  let updated = 0;
  const updatedMsgs = messages.map((m) => {
    if (idSet.has(m.id)) { updated++; return { ...m, status: body.status }; }
    return m;
  });
  if (updated > 0) await saveMessagesRebuild(updatedMsgs);
  return c.json({ updated, total: body.messageIds.length });
});

/**
 * Update Campaign metrics post-publication. Body: { impressions?, clicks?, installs?, revenue_cents? }
 * Used by manual entry until ad-network integrations land. Aggregates onto the
 * Campaign message's metadata; revenue_cents also accumulates onto the project's earned_cents.
 */
org.post('/campaigns/:messageId/metrics', async (c) => {
  const messageId = c.req.param('messageId');
  const body = await c.req.json<{ impressions?: number; clicks?: number; installs?: number; revenue_cents?: number }>();
  const messages = loadMessages();
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return c.json({ error: 'message not found' }, 404);
  if (messages[idx].kind !== 'Campaign') return c.json({ error: 'message is not a Campaign' }, 400);
  const m = messages[idx];
  const md = (m.metadata ?? {}) as any;
  messages[idx] = {
    ...m,
    metadata: {
      ...md,
      impressions: (md.impressions ?? 0) + (body.impressions ?? 0),
      clicks: (md.clicks ?? 0) + (body.clicks ?? 0),
      installs: (md.installs ?? 0) + (body.installs ?? 0),
      revenue_cents: (md.revenue_cents ?? 0) + (body.revenue_cents ?? 0),
      lastMetricUpdateTs: Date.now(),
    },
  };
  await saveMessagesRebuild(messages);
  // Also accumulate revenue onto the project's earned_cents
  if (body.revenue_cents && m.projectId) {
    const projects = loadProjects();
    const pIdx = projects.findIndex((p) => p.id === m.projectId);
    if (pIdx !== -1) {
      projects[pIdx] = { ...projects[pIdx], earned_cents: (projects[pIdx].earned_cents ?? 0) + body.revenue_cents };
      await saveProjects(projects);
    }
  }
  await appendAudit('campaign.metrics', messageId, body);
  return c.json({ message: messages[idx] });
});

/**
 * Secrets layer for credentials that workers need to ship apps to stores,
 * call paid APIs, etc. Each secret is a single-key file at
 * ~/.restart-org/secrets/<key>.txt with mode 0600. The list endpoint
 * returns only key names + lengths, never plaintext, so it's safe to expose
 * in the UI. The get endpoint returns plaintext and is intended for workers /
 * scripts called server-side. There's no client-side UI for fetching the value.
 */
org.get('/secrets', async (c) => {
  if (!existsSync(SECRETS_DIR)) return c.json({ secrets: [] });
  const files = readdirSync(SECRETS_DIR).filter((f) => f.endsWith('.txt'));
  const secrets = files.map((f) => {
    const content = readFileSync(join(SECRETS_DIR, f), 'utf8');
    return { key: f.replace(/\.txt$/, ''), length: content.length, lastModified: null };
  });
  return c.json({ secrets });
});

org.get('/secrets/:key', (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return c.json({ error: 'invalid key (alphanumeric / _ / - only)' }, 400);
  const path = join(SECRETS_DIR, `${key}.txt`);
  if (!existsSync(path)) return c.json({ error: 'secret not found' }, 404);
  return c.json({ key, value: readFileSync(path, 'utf8') });
});

org.put('/secrets/:key', async (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return c.json({ error: 'invalid key (alphanumeric / _ / - only)' }, 400);
  const body = await c.req.json<{ value: string }>();
  if (typeof body.value !== 'string') return c.json({ error: 'value (string) required' }, 400);
  if (!existsSync(SECRETS_DIR)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
  const path = join(SECRETS_DIR, `${key}.txt`);
  await writeFile(path, body.value, { mode: 0o600 });
  await appendAudit('secret.set', key, { length: body.value.length });
  return c.json({ ok: true, key, length: body.value.length });
});

org.delete('/secrets/:key', async (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return c.json({ error: 'invalid key' }, 400);
  const path = join(SECRETS_DIR, `${key}.txt`);
  if (!existsSync(path)) return c.json({ error: 'secret not found' }, 404);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(path);
  await appendAudit('secret.delete', key, {});
  return c.json({ deleted: true, key });
});

/**
 * Admin: invoke an ACTIONS op directly (same machinery the autonomous loop uses).
 * Body: { action: { op: '<op>', ... } }
 * Useful for manual scaffolding, testing new ops, and one-off operator actions
 * that don't need to come from a director.
 */
org.post('/admin/execute-action', async (c) => {
  const body = await c.req.json<{ action: any; callingDept?: string }>();
  if (!body?.action?.op) return c.json({ error: 'action.op required' }, 400);
  try {
    const result = await executeAction(body.action, body.callingDept);
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? String(e) }, 400);
  }
});

org.post('/admin/archive-acknowledged', async (c) => {
  const body = await c.req.json<{ olderThanMs?: number }>().catch(() => ({} as any));
  const cutoff = typeof body.olderThanMs === 'number' ? Date.now() - body.olderThanMs : Date.now() - 30 * 86_400_000; // default 30d
  const messages = loadMessages();
  let archived = 0;
  const updated = messages.map((m) => {
    if (m.status === 'acknowledged' && m.ts < cutoff) { archived++; return { ...m, status: 'archived' as MessageStatus }; }
    return m;
  });
  if (archived > 0) await saveMessagesRebuild(updated);
  await appendAudit('admin.archive-acknowledged', 'org', { archived, cutoff });
  return c.json({ archived, cutoffISO: new Date(cutoff).toISOString() });
});

org.patch('/messages/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ status: MessageStatus }>();
  const validStatuses: MessageStatus[] = ['pending', 'acknowledged', 'actioned', 'archived'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: `invalid status: ${body.status}` }, 400);
  }
  const messages = loadMessages();
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return c.json({ error: 'message not found' }, 404);
  messages[idx] = { ...messages[idx], status: body.status };
  await saveMessagesRebuild(messages);
  return c.json({ message: messages[idx] });
});

// -------- Rebuild endpoint (admin) --------
org.post('/admin/rebuild-views', async (c) => {
  const messages = loadMessages();
  await rebuildInboxOutboxViews(messages);
  return c.json({ ok: true, messageCount: messages.length });
});

// -------- Projects --------
org.get('/projects', (c) => {
  const projects = loadProjects();
  const vertical = c.req.query('vertical');
  const filtered = vertical ? projects.filter((p) => p.vertical === vertical) : projects;
  return c.json({ projects: filtered });
});

org.get('/projects/:slug', (c) => {
  const slug = c.req.param('slug');
  const project = loadProjects().find((p) => p.slug === slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const messages = loadMessages().filter((m) => m.projectId === project.id);
  return c.json({
    project,
    messageCount: messages.length,
    recentActivity: messages.sort((a, b) => b.ts - a.ts).slice(0, 10),
  });
});

org.post('/projects', async (c) => {
  const body = await c.req.json<{
    slug: string;
    name: string;
    vertical: string;
    owning_director?: string;
    budget_cents?: number;
    cost_cap_cents?: number;
    metadata?: Record<string, unknown>;
  }>();

  if (!body.slug || !body.name || !body.vertical) {
    return c.json({ error: 'slug, name, and vertical are required' }, 400);
  }

  const projects = loadProjects();
  if (projects.some((p) => p.slug === body.slug)) {
    return c.json({ error: 'slug already exists' }, 409);
  }

  const project: Project = {
    id: randomUUID(),
    slug: body.slug,
    name: body.name,
    vertical: body.vertical,
    status: 'proposed',
    owning_director: body.owning_director ?? 'management',
    budget_cents: body.budget_cents ?? 0,
    spent_cents: 0,
    earned_cents: 0,
    cost_cap_cents: body.cost_cap_cents,
    created_ts: Date.now(),
    metadata: body.metadata,
  };

  projects.push(project);
  await saveProjects(projects);

  // Emit ProjectKickoff broadcast
  const kickoff: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: 'management',
    to: ['business', 'rd', 'technology', 'marketing', 'management'],
    kind: 'ProjectKickoff',
    subject: `Project kickoff: ${project.name}`,
    body: `A new project has been kicked off.\n\n- Slug: ${project.slug}\n- Vertical: ${project.vertical}\n- Budget: $${(project.budget_cents / 100).toFixed(2)}\n- Owning director: ${project.owning_director}`,
    projectId: project.id,
    status: 'pending',
  };
  await appendMessage(kickoff);

  return c.json({ project });
});

org.get('/audit', (c) => {
  const subject = c.req.query('subject');
  const action = c.req.query('action');
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  let entries = loadAudit();
  if (subject) entries = entries.filter((e) => e.subject === subject);
  if (action) entries = entries.filter((e) => e.action === action);
  entries.sort((a, b) => b.ts - a.ts);
  return c.json({ entries: entries.slice(0, limit) });
});

org.get('/messages/:id/comments', (c) => {
  const id = c.req.param('id');
  const comments = loadComments().filter((x) => x.messageId === id).sort((a, b) => a.ts - b.ts);
  return c.json({ comments });
});

org.post('/messages/:id/comments', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ body: string; author?: string }>();
  if (!body.body?.trim()) return c.json({ error: 'body required' }, 400);
  const msg = loadMessages().find((x) => x.id === id);
  if (!msg) return c.json({ error: 'message not found' }, 404);
  const comment: MessageComment = {
    id: randomUUID(),
    messageId: id,
    ts: Date.now(),
    author: body.author ?? 'user',
    body: body.body,
  };
  await appendComment(comment);
  return c.json({ comment });
});

/**
 * SSE-streaming variant of run-director. Client connects, server spawns claude,
 * streams stdout chunks as they arrive, sends `done` event when complete.
 */

org.delete('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (slug === 'platform' || slug === 'org-ops') {
    return c.json({ error: 'cannot delete reserved project' }, 400);
  }
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.slug === slug);
  if (idx === -1) return c.json({ error: 'project not found' }, 404);
  const project = projects[idx];
  // Soft-relink any messages tagged with this project to org-ops to preserve history
  const messages = loadMessages();
  let relinked = 0;
  const updated = messages.map((m) => {
    if (m.projectId === project.id) { relinked++; return { ...m, projectId: PROJECT_ORG_OPS }; }
    return m;
  });
  await saveMessagesRebuild(updated);
  // Unlink from any directives
  const directives = loadDirectives();
  let unlinked = 0;
  const updatedDirectives = directives.map((d) => {
    if (d.linkedProjectIds?.includes(project.id)) {
      unlinked++;
      return { ...d, linkedProjectIds: d.linkedProjectIds.filter((id) => id !== project.id) };
    }
    return d;
  });
  await saveDirectives(updatedDirectives);
  // Remove project
  projects.splice(idx, 1);
  await saveProjects(projects);
  await appendAudit('project.delete', slug, { relinkedMessages: relinked, unlinkedFromDirectives: unlinked, name: project.name });
  return c.json({ deleted: true, relinkedMessages: relinked, unlinkedFromDirectives: unlinked });
});

/**
 * Record revenue against a project (incremental; manual entry until automated
 * IAP/Stripe webhook integration exists). Body: { amount_cents: number, note?: string }
 * Accumulates onto project.earned_cents and writes an audit entry.
 */
org.post('/projects/:slug/record-revenue', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<{ amount_cents: number; note?: string }>();
  if (typeof body.amount_cents !== 'number' || !isFinite(body.amount_cents)) {
    return c.json({ error: 'amount_cents (number) required' }, 400);
  }
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.slug === slug);
  if (idx === -1) return c.json({ error: 'project not found' }, 404);
  projects[idx] = { ...projects[idx], earned_cents: (projects[idx].earned_cents ?? 0) + body.amount_cents };
  await saveProjects(projects);
  await appendAudit('project.revenue', slug, { amount_cents: body.amount_cents, note: body.note, total_earned_cents: projects[idx].earned_cents });
  return c.json({ project: projects[idx] });
});

org.patch('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Partial<Project>>();
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.slug === slug);
  if (idx === -1) return c.json({ error: 'project not found' }, 404);
  const existing = projects[idx];
  projects[idx] = {
    ...existing,
    ...body,
    id: existing.id, // ids are immutable
    slug: existing.slug, // slugs are immutable
    created_ts: existing.created_ts,
  };
  await saveProjects(projects);
  return c.json({ project: projects[idx] });
});

org.get('/projects/:slug/timeline', (c) => {
  const slug = c.req.param('slug');
  const project = loadProjects().find((p) => p.slug === slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const messages = loadMessages().filter((m) => m.projectId === project.id);
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

org.get('/projects/:slug/capabilities', (c) => {
  const slug = c.req.param('slug');
  const project = loadProjects().find((p) => p.slug === slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const messages = loadMessages().filter((m) => m.projectId === project.id && m.kind === 'Capability');
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

org.get('/projects/:slug/spinouts', (c) => {
  const slug = c.req.param('slug');
  const project = loadProjects().find((p) => p.slug === slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const messages = loadMessages().filter((m) => m.projectId === project.id && m.kind === 'ProjectSpinout');
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

org.get('/projects/:slug/campaigns', (c) => {
  const slug = c.req.param('slug');
  const project = loadProjects().find((p) => p.slug === slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const messages = loadMessages().filter((m) => m.projectId === project.id && m.kind === 'Campaign');
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

// ================================================================
// Directives
// ================================================================

function loadDirectives(): Directive[] {
  if (!existsSync(DIRECTIVES_PATH)) return [];
  const raw = readFileSync(DIRECTIVES_PATH, 'utf8');
  return JSON.parse(raw).directives as Directive[];
}

async function saveDirectives(directives: Directive[]): Promise<void> {
  await mkdir(ORG_ROOT, { recursive: true });
  await writeFile(DIRECTIVES_PATH, JSON.stringify({ version: 1, directives }, null, 2));
}

function loadSummaries(): DirectiveSummary[] {
  if (!existsSync(DIRECTIVE_SUMMARIES_PATH)) return [];
  const raw = readFileSync(DIRECTIVE_SUMMARIES_PATH, 'utf8');
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as DirectiveSummary);
}

async function appendSummary(s: DirectiveSummary): Promise<void> {
  await appendFile(DIRECTIVE_SUMMARIES_PATH, JSON.stringify(s) + '\n');
  try {
    const c = getOrgDbClient();
    await c.prepare('INSERT INTO directive_summaries (id, directive_id, ts, author, body) VALUES (@id, @directive_id, @ts, @author, @body) ON CONFLICT (id) DO NOTHING')
      .run({ id: s.id, directive_id: s.directiveId, ts: s.ts, author: s.author ?? 'ceo', body: s.body ?? '' });
  } catch (e) {
    console.warn('[org dual-write] SQL summary insert failed:', (e as Error)?.message);
  }
}

async function appendAudit(action: string, subject: string, details?: Record<string, unknown>, actor = 'user'): Promise<void> {
  const entry: AuditEntry = {
    id: randomUUID(),
    ts: Date.now(),
    actor,
    action,
    subject,
    details,
  };
  try { await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n'); } catch {}
  try {
    const c = getOrgDbClient();
    await c.prepare('INSERT INTO audit_log (id, ts, actor, action, subject, details) VALUES (@id, @ts, @actor, @action, @subject, @details) ON CONFLICT (id) DO NOTHING')
      .run({ id: entry.id, ts: entry.ts, actor: entry.actor, action: entry.action, subject: entry.subject, details: details == null ? null : JSON.stringify(details) });
  } catch (e) {
    console.warn('[org dual-write] SQL audit insert failed:', (e as Error)?.message);
  }
}

function loadAudit(): AuditEntry[] {
  if (!existsSync(AUDIT_LOG_PATH)) return [];
  const raw = readFileSync(AUDIT_LOG_PATH, 'utf8');
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
}

function loadComments(): MessageComment[] {
  if (!existsSync(COMMENTS_PATH)) return [];
  const raw = readFileSync(COMMENTS_PATH, 'utf8');
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as MessageComment);
}

async function appendComment(c: MessageComment): Promise<void> {
  await appendFile(COMMENTS_PATH, JSON.stringify(c) + '\n');
}

function nextDirectiveId(directives: Directive[]): string {
  const nums = directives
    .map((d) => /^D-(\d+)$/.exec(d.id)?.[1])
    .filter(Boolean)
    .map((n) => parseInt(n!, 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `D-${String(max + 1).padStart(3, '0')}`;
}

org.get('/directives', (c) => {
  const directives = loadDirectives();
  const status = c.req.query('status');
  const filtered = status ? directives.filter((d) => d.status === status) : directives;
  return c.json({ directives: filtered.sort((a, b) => b.created_ts - a.created_ts) });
});

org.post('/directives', async (c) => {
  const body = await c.req.json<{
    title: string;
    body: string;
    deadline_ts?: number;
    budget_cents?: number;
    priority?: 'low' | 'normal' | 'high';
    created_by?: string;
    /** Operator-provided constraints to make CEO routing reproducible. */
    constraints?: {
      target_market?: string;
      monetization_model?: string;
      success_metric?: string;
    };
  }>();
  if (!body.title?.trim() || !body.body?.trim()) {
    return c.json({ error: 'title and body are required' }, 400);
  }
  // Soft warning: a tight directive has at least a budget, deadline, and one constraint.
  // We don't reject vague directives (CEO will route them anyway) but we do flag them.
  const tightnessWarnings: string[] = [];
  if (!body.budget_cents || body.budget_cents <= 0) tightnessWarnings.push('no budget set — CEO will route into projects with $0');
  if (!body.deadline_ts) tightnessWarnings.push('no deadline — CEO has no time-pressure signal');
  if (!body.constraints || Object.keys(body.constraints).length === 0) tightnessWarnings.push('no constraints (target_market / monetization_model / success_metric) — routing will be less reproducible');

  const directives = loadDirectives();
  const directive: Directive = {
    id: nextDirectiveId(directives),
    title: body.title.trim(),
    body: body.body,
    status: 'active',
    created_by: body.created_by ?? 'user',
    created_ts: Date.now(),
    deadline_ts: body.deadline_ts,
    budget_cents: body.budget_cents,
    priority: body.priority ?? 'normal',
  };
  if (body.constraints) (directive as any).constraints = body.constraints;
  directives.push(directive);
  await saveDirectives(directives);

  // Auto-emit a Directive message to Business inbox.
  // ProjectId = org-ops (governance) since the Directive itself is meta-work;
  // a project gets auto-created when the directive is routed.
  const msg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: 'user',
    to: ['business'],
    kind: 'Directive',
    subject: directive.title,
    body: directive.body,
    projectId: PROJECT_ORG_OPS,
    directiveId: directive.id,
    status: 'pending',
    metadata: {
      priority: directive.priority,
      deadline_ts: directive.deadline_ts,
      budget_cents: directive.budget_cents,
    },
  };
  await appendMessage(msg);

  return c.json({ directive, tightnessWarnings });
});

org.get('/directives/:id', (c) => {
  const id = c.req.param('id');
  const directive = loadDirectives().find((d) => d.id === id);
  if (!directive) return c.json({ error: 'directive not found' }, 404);
  const summaries = loadSummaries().filter((s) => s.directiveId === id);
  const messages = loadMessages().filter((m) => m.directiveId === id);
  return c.json({
    directive,
    summaries: summaries.sort((a, b) => a.ts - b.ts),
    messages: messages.sort((a, b) => a.ts - b.ts),
  });
});

org.patch('/directives/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<Directive>>();
  const directives = loadDirectives();
  const idx = directives.findIndex((d) => d.id === id);
  if (idx === -1) return c.json({ error: 'directive not found' }, 404);
  const existing = directives[idx];
  directives[idx] = {
    ...existing,
    ...body,
    id: existing.id,
    created_ts: existing.created_ts,
    created_by: existing.created_by,
  };
  await saveDirectives(directives);
  return c.json({ directive: directives[idx] });
});

org.delete('/directives/:id', async (c) => {
  const id = c.req.param('id');
  const directives = loadDirectives();
  const idx = directives.findIndex((d) => d.id === id);
  if (idx === -1) return c.json({ error: 'directive not found' }, 404);
  directives[idx] = { ...directives[idx], status: 'cancelled' };
  await saveDirectives(directives);
  return c.json({ directive: directives[idx] });
});

org.get('/directives/:id/summaries', (c) => {
  const id = c.req.param('id');
  const summaries = loadSummaries().filter((s) => s.directiveId === id);
  return c.json({ summaries: summaries.sort((a, b) => a.ts - b.ts) });
});

org.post('/directives/:id/summaries', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ body: string; author?: 'ceo' | 'user'; linkedMessageIds?: string[] }>();
  if (!body.body?.trim()) return c.json({ error: 'body required' }, 400);
  const directive = loadDirectives().find((d) => d.id === id);
  if (!directive) return c.json({ error: 'directive not found' }, 404);
  const summary: DirectiveSummary = {
    id: randomUUID(),
    directiveId: id,
    ts: Date.now(),
    author: body.author ?? 'user',
    body: body.body,
    linkedMessageIds: body.linkedMessageIds,
  };
  await appendSummary(summary);
  return c.json({ summary });
});

org.get('/directives/:id/timeline', (c) => {
  const id = c.req.param('id');
  const messages = loadMessages().filter((m) => m.directiveId === id);
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

/**
 * Spin up an additional project for a directive. A directive can have many
 * projects (1:N) — each /projects POST adds another project. The CEO (or human)
 * decides when one directive needs multiple parallel projects (e.g. "Launch music
 * app" might split into a backend project, an iOS project, and a marketing site).
 *
 * Body (all optional):
 *   { projectName, projectVertical, projectBudgetCents, additionalContext, departments[], reuseProjectId }
 */
org.post('/directives/:id/projects', async (c) => {
  const id = c.req.param('id');
  const directives = loadDirectives();
  const dIdx = directives.findIndex((d) => d.id === id);
  if (dIdx === -1) return c.json({ error: 'directive not found' }, 404);
  const directive = directives[dIdx];

  const body = await c.req.json<{
    projectName?: string;
    projectVertical?: string;
    projectBudgetCents?: number;
    reuseProjectId?: string;
    additionalContext?: string;
    departments?: string[];
  }>().catch(() => ({} as any));

  const allProjects = loadProjects();
  let projectId: string;
  let projectSlug: string;
  let createdNew = false;

  if (body.reuseProjectId) {
    const existing = allProjects.find((p) => p.id === body.reuseProjectId || p.slug === body.reuseProjectId);
    if (!existing) return c.json({ error: `unknown project: ${body.reuseProjectId}` }, 400);
    projectId = existing.id;
    projectSlug = existing.slug;
  } else {
    const baseName = body.projectName?.trim() || directive.title;
    const baseSlugRaw = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      || `directive-${directive.id.toLowerCase()}`;
    let slug = baseSlugRaw;
    let i = 2;
    while (allProjects.some((p) => p.slug === slug)) slug = `${baseSlugRaw}-${i++}`;

    const content = `${directive.title}\n${directive.body}\n${body.additionalContext ?? ''}`.toLowerCase();
    let vertical = body.projectVertical?.trim() || 'apps';
    if (!body.projectVertical) {
      if (/construction|building|retrofit|hvac|electrical|plumbing/.test(content)) vertical = 'construction';
      else if (/platform|library|infra|shared|sdk|tool/.test(content)) vertical = 'platform';
    }

    const project: Project = {
      id: randomUUID(),
      slug,
      name: baseName,
      vertical,
      status: 'approved',
      owning_director: 'management',
      budget_cents: body.projectBudgetCents ?? 0,
      spent_cents: 0,
      created_ts: Date.now(),
      metadata: { sourceDirective: directive.id, additionalContext: body.additionalContext },
    };
    allProjects.push(project);
    await saveProjects(allProjects);
    projectId = project.id;
    projectSlug = slug;
    createdNew = true;

    directives[dIdx] = {
      ...directive,
      linkedProjectIds: [...(directive.linkedProjectIds ?? []), project.id],
    };

    const isAdditional = (directive.linkedProjectIds ?? []).length > 0;
    const kickoff: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: 'management',
      to: ['business', 'rd', 'technology', 'marketing', 'management'],
      kind: 'ProjectKickoff',
      subject: `Project kickoff: ${project.name}${isAdditional ? ' (additional)' : ''}`,
      body: `Project ${isAdditional ? '(additional) ' : ''}kicked off for directive ${directive.id}: "${directive.title}".\n\n- Slug: ${project.slug}\n- Vertical: ${project.vertical}\n- Budget: ${(project.budget_cents / 100).toFixed(2)}${body.additionalContext ? `\n- Scope: ${body.additionalContext}` : ''}`,
      projectId,
      directiveId: directive.id,
      status: 'pending',
    };
    await appendMessage(kickoff);
  }

  // Routing
  const content = `${directive.title}\n${directive.body}\n${body.additionalContext ?? ''}`.toLowerCase();
  const assigned: Set<string> = new Set(body.departments && body.departments.length > 0 ? body.departments : []);
  if (assigned.size === 0) {
    assigned.add('management');
    if (/build|ship|feature|tech|platform|library|lib|api/.test(content)) assigned.add('technology');
    if (/research|idea|explore|novel|prototype|r&?d/.test(content)) assigned.add('rd');
    if (/acquire|customer|marketing|launch|campaign|churn|demand/.test(content)) assigned.add('marketing');
  }
  const assignedList = Array.from(assigned);

  const priorityMsg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: 'business',
    to: assignedList,
    kind: 'Priority',
    subject: `Directive ${directive.id} → ${projectSlug}: ${directive.title}`,
    body: `Directive **${directive.id}** routed to project **${projectSlug}**.\n\nDirective: ${directive.body}${body.additionalContext ? `\n\nProject scope: ${body.additionalContext}` : ''}\n\nPlease reflect in your current priorities.`,
    projectId,
    directiveId: directive.id,
    status: 'pending',
    metadata: { directiveId: directive.id, projectId, priority: directive.priority ?? 'normal' },
  };
  await appendMessage(priorityMsg);

  if (body.projectBudgetCents && body.projectBudgetCents > 0) {
    const budgetMsg: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: 'business',
      to: ['management'],
      kind: 'BudgetAllocation',
      subject: `Budget for ${projectSlug}`,
      body: `Allocated ${(body.projectBudgetCents / 100).toFixed(2)} for project ${projectSlug} (under directive ${directive.id}: ${directive.title}).`,
      projectId,
      directiveId: directive.id,
      status: 'pending',
      metadata: { amount_cents: body.projectBudgetCents, directiveId: directive.id, projectId },
    };
    await appendMessage(budgetMsg);
  }

  // Cumulative dept assignments on the directive
  const allAssigned = new Set([...(directive.assignedDepartments ?? []), ...assignedList]);
  directives[dIdx] = { ...directives[dIdx], assignedDepartments: Array.from(allAssigned) };
  await saveDirectives(directives);

  const totalProjects = (directives[dIdx].linkedProjectIds ?? []).length;
  const projectClause = createdNew
    ? `Spun up project **${projectSlug}** (project #${totalProjects} for this directive).`
    : `Routed work to existing project **${projectSlug}**.`;
  const summary: DirectiveSummary = {
    id: randomUUID(),
    directiveId: id,
    ts: Date.now(),
    author: 'ceo',
    body: `${projectClause}${body.additionalContext ? `\n\nScope: ${body.additionalContext}` : ''}\n\nAssigned to: **${assignedList.join(', ')}**.${body.projectBudgetCents ? ` Project budget: ${(body.projectBudgetCents / 100).toFixed(2)}.` : ''}`,
  };
  await appendSummary(summary);

  return c.json({
    directive: directives[dIdx],
    projectId,
    projectSlug,
    createdNew,
    totalProjects,
    routedMessages: [priorityMsg.id],
    summary,
  });
});

/**
 * Naive CEO routing pass. Fires default Priority/BudgetAllocation messages to
 * relevant departments based on directive content heuristics. LLM-backed
 * routing will replace this when the agent template inheritance lands.
 */
org.post('/directives/:id/route', async (c) => {
  const id = c.req.param('id');
  const directives = loadDirectives();
  const dIdx = directives.findIndex((d) => d.id === id);
  if (dIdx === -1) return c.json({ error: 'directive not found' }, 404);
  const directive = directives[dIdx];

  const content = `${directive.title}\n${directive.body}`.toLowerCase();

  const assigned: Set<string> = new Set();
  assigned.add('management');
  if (/build|ship|feature|tech|platform|library|lib|api/.test(content)) assigned.add('technology');
  if (/research|idea|explore|novel|prototype|r&?d/.test(content)) assigned.add('rd');
  if (/acquire|customer|marketing|launch|campaign|churn|demand/.test(content)) assigned.add('marketing');
  const assignedList = Array.from(assigned);

  // Auto-create a project so all routed messages have projectId
  let projectId: string | undefined = directive.linkedProjectIds?.[0];
  let projectSlug: string | undefined;
  if (!projectId) {
    const projects = loadProjects();
    const baseSlug = directive.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      || `directive-${directive.id.toLowerCase()}`;
    let slug = baseSlug;
    let i = 2;
    while (projects.some((p) => p.slug === slug)) slug = `${baseSlug}-${i++}`;
    let vertical = 'apps';
    if (/construction|building|retrofit|hvac|electrical|plumbing/.test(content)) vertical = 'construction';
    else if (/platform|library|infra|shared|sdk|tool/.test(content)) vertical = 'platform';
    const project: Project = {
      id: randomUUID(),
      slug,
      name: directive.title,
      vertical,
      status: 'approved',
      owning_director: 'management',
      budget_cents: directive.budget_cents ?? 0,
      spent_cents: 0,
      created_ts: Date.now(),
      metadata: { sourceDirective: directive.id },
    };
    projects.push(project);
    await saveProjects(projects);
    projectId = project.id;
    projectSlug = slug;
    directives[dIdx] = { ...directive, linkedProjectIds: [...(directive.linkedProjectIds ?? []), project.id] };
    const kickoff: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: 'management',
      to: ['business', 'rd', 'technology', 'marketing', 'management'],
      kind: 'ProjectKickoff',
      subject: `Project kickoff: ${project.name}`,
      body: `Project kicked off from directive ${directive.id}.\n\n- Slug: ${project.slug}\n- Vertical: ${project.vertical}\n- Budget: ${(project.budget_cents / 100).toFixed(2)}`,
      projectId,
      directiveId: directive.id,
      status: 'pending',
    };
    await appendMessage(kickoff);
  }

  const priorityMsg: Message = {
    id: randomUUID(),
    ts: Date.now(),
    from: 'business',
    to: assignedList,
    kind: 'Priority',
    subject: `Directive ${directive.id}: ${directive.title}`,
    body: `The following directive has been assigned to you:\n\n**${directive.title}**\n\n${directive.body}\n\nProject: ${projectSlug ?? projectId}\n\nPlease reflect this in your current priorities.`,
    projectId,
    directiveId: directive.id,
    status: 'pending',
    metadata: { directiveId: directive.id, projectId, priority: directive.priority ?? 'normal' },
  };
  await appendMessage(priorityMsg);

  if (directive.budget_cents && directive.budget_cents > 0) {
    const budgetMsg: Message = {
      id: randomUUID(),
      ts: Date.now(),
      from: 'business',
      to: ['management'],
      kind: 'BudgetAllocation',
      subject: `Budget for directive ${directive.id}`,
      body: `Allocated ${(directive.budget_cents / 100).toFixed(2)} for directive ${directive.id}: ${directive.title}`,
      projectId,
      directiveId: directive.id,
      status: 'pending',
      metadata: { amount_cents: directive.budget_cents, directiveId: directive.id, projectId },
    };
    await appendMessage(budgetMsg);
  }

  directives[dIdx] = { ...directives[dIdx], assignedDepartments: assignedList };
  await saveDirectives(directives);

  const projectClause = projectSlug
    ? `Auto-created project **${projectSlug}** to scope this directive's work.`
    : `Reused linked project ${projectId}.`;
  const summary: DirectiveSummary = {
    id: randomUUID(),
    directiveId: id,
    ts: Date.now(),
    author: 'ceo',
    body: `Directive routed. Assigned to: **${assignedList.join(', ')}**. ${projectClause}${directive.budget_cents ? ` Budget of ${(directive.budget_cents / 100).toFixed(2)} allocated to Management.` : ''}\n\nHeuristic routing based on directive content keywords. Full agent-driven routing pending director runtime integration.`,
  };
  await appendSummary(summary);

  return c.json({
    directive: directives[dIdx],
    projectId,
    projectSlug,
    routedMessages: [priorityMsg.id],
    summary,
  });
});

// ================================================================
// Prompt resolver — concatenates base + kind + per-dept prompts
// ================================================================

const PROMPTS_ROOT = join(
  process.env.PAPERCUSP_HARNESS_DIR ?? join(homedir(), 'autonomous-harness'),
  'prompts',
);

function readPromptIfExists(relPath: string): string | null {
  const path = join(PROMPTS_ROOT, relPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/**
 * Synthesize recent director-run history into a compact memory block.
 * Reads the last `limit` run records (newest-first) and extracts the decision
 * keyword + the first ACTIONS line so a director can recall what it did
 * recently without re-reading every run file.
 */
function synthesizeRecentMemory(harnessSlug: string, limit = 12): {
  entries: Array<{ filename: string; ts: string | null; decision: string | null; firstAction: string | null; final: string | null }>;
  text: string;
} {
  const runsDir = join(homedir(), harnessSlug, '.harness', 'director-runs');
  if (!existsSync(runsDir)) return { entries: [], text: '(no prior runs)' };
  let files: string[] = [];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, limit);
  } catch {
    return { entries: [], text: '(no prior runs)' };
  }
  const entries = files.map((f) => {
    let content = '';
    try { content = readFileSync(join(runsDir, f), 'utf8'); } catch {}
    const ts = content.match(/- ts: (.+)/)?.[1]?.trim() ?? null;
    const decision = content.match(/- decisionKeyword: (.+)/)?.[1]?.trim() ?? null;
    const final = content.match(/- final: (.+)/)?.[1]?.trim() ?? null;
    const actionsBlock = content.match(/```actions\n([\s\S]*?)\n```/);
    const firstAction = actionsBlock?.[1]?.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? null;
    return { filename: f, ts, decision, firstAction, final };
  });
  if (entries.length === 0) return { entries, text: '(no prior runs)' };
  const lines = entries.map((e) => {
    const parts = [e.ts ?? '?', e.decision ? `[${e.decision}]` : '', e.firstAction ? `→ ${e.firstAction}` : '', e.final && e.final !== e.decision ? `(final:${e.final})` : ''].filter(Boolean);
    return `- ${parts.join(' ')}`;
  });
  return { entries, text: lines.join('\n') };
}

async function buildResolvedPrompt(slug: string, role: string, mode?: string, includeContext = false): Promise<{ sections: string[]; resolved: string; error?: string }> {
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return { sections: [], resolved: '', error: 'department not found' };

  const validRoles = ['orchestrator', 'worker', 'validator', 'documenter', 'summarizer'];
  if (!validRoles.includes(role)) return { sections: [], resolved: '', error: `invalid role: ${role}` };

  const sections: Array<{ source: string; content: string }> = [];
  const baseContent = readPromptIfExists(`base/${role}.md`);
  if (baseContent) sections.push({ source: `base/${role}.md`, content: baseContent });
  const deptContent = readPromptIfExists(`department/${role}.md`);
  if (deptContent) sections.push({ source: `department/${role}.md`, content: deptContent });
  const perDeptContent = readPromptIfExists(`department/departments/${slug}/${role}.md`);
  if (perDeptContent) sections.push({ source: `department/departments/${slug}/${role}.md`, content: perDeptContent });
  if (mode === 'ceo' && slug === 'business' && role === 'worker') {
    const ceoContent = readPromptIfExists('department/departments/business/ceo.md');
    if (ceoContent) sections.push({ source: 'department/departments/business/ceo.md (ceo mode)', content: ceoContent });
  }
  if (sections.length === 0) return { sections: [], resolved: '', error: `no prompt files for role=${role}` };

  let resolved = sections.map((s) => `<!-- source: ${s.source} -->\n${s.content}`).join('\n\n---\n\n');

  if (includeContext) {
    const charter = existsSync(CHARTER_PATH) ? readFileSync(CHARTER_PATH, 'utf8') : '';
    // Layer 3: read inbox/outbox from SQL (canonical) instead of JSONL projections.
    let inboxRaw = '';
    let outboxRaw = '';
    try {
      const c = getOrgDbClient();
      const inboxRows = await c.prepare(`
        SELECT m.* FROM messages m
        JOIN message_recipients r ON r.message_id = m.id
        WHERE r.dept_slug = ? ORDER BY m.ts DESC LIMIT 50
      `).all(slug) as any[];
      const outboxRows = await c.prepare(`
        SELECT * FROM messages WHERE from_dept = ? ORDER BY ts DESC LIMIT 50
      `).all(slug) as any[];
      const toJsonl = (rows: any[]) => rows.map((r) => JSON.stringify({
        id: r.id, ts: typeof r.ts === 'bigint' ? Number(r.ts) : r.ts, from: r.from_dept, kind: r.kind, subject: r.subject,
        body: r.body, refId: r.ref_id, projectId: r.project_id, directiveId: r.directive_id,
        status: r.status, metadata: r.metadata ?? null,
      })).join('\n');
      inboxRaw = toJsonl(inboxRows);
      outboxRaw = toJsonl(outboxRows);
    } catch {
      // SQL store may not be ready in tests; fall back to legacy JSONL projection
      const inboxPath = join(homedir(), dept.harnessSlug, '.harness', 'inbox-view.jsonl');
      inboxRaw = existsSync(inboxPath) ? readFileSync(inboxPath, 'utf8') : '';
      const outboxPath = join(homedir(), dept.harnessSlug, '.harness', 'outbox-view.jsonl');
      outboxRaw = existsSync(outboxPath) ? readFileSync(outboxPath, 'utf8') : '';
    }
    const dirNotesPath = join(homedir(), dept.harnessSlug, '.harness', 'director-notes.md');
    const dirNotes = existsSync(dirNotesPath) ? readFileSync(dirNotesPath, 'utf8') : '';
    const decisionLogPath = join(homedir(), dept.harnessSlug, '.harness', 'decision-log.md');
    const decisionLog = existsSync(decisionLogPath) ? readFileSync(decisionLogPath, 'utf8') : '';

    const memory = synthesizeRecentMemory(dept.harnessSlug, 12);
    const mission = existsSync(MISSION_PATH) ? readFileSync(MISSION_PATH, 'utf8') : '';
    const ctx = `\n\n---\n\n# Live state for ${dept.name} (${slug}) at ${new Date().toISOString()}\n\n## Mission (north-star — every dept reads this)\n\n${mission || '(no mission file at ~/.restart-org/mission.md — operate without explicit mission)'}\n\n## Charter\n\n${charter}\n\n## Director notes\n\n${dirNotes}\n\n## Decision log\n\n${decisionLog}\n\n## Recent decisions (your own memory, newest first)\n\n${memory.text}\n\n## Inbox (newest first)\n\n\`\`\`jsonl\n${inboxRaw.trim() || '(empty)'}\n\`\`\`\n\n## Outbox (newest first)\n\n\`\`\`jsonl\n${outboxRaw.trim() || '(empty)'}\n\`\`\`\n\n# Your task right now\n\nFollowing the rules above, decide what to do next. Output a single decision keyword on the FIRST line of your response (e.g. \`NEXT_WORKER <MESSAGE_ID>\`, \`NEXT_WORKER_CEO_MODE <MESSAGE_ID>\`, \`DONE\`, \`ESCALATE <id> <reason>\`). After the decision keyword, you may write up to 3 lines of reasoning.\n`;
    resolved = resolved + ctx;
  }

  return { sections: sections.map((s) => s.source), resolved };
}

org.get('/:dept/prompt', async (c) => {
  const slug = c.req.param('dept');
  const role = c.req.query('role') ?? 'orchestrator';
  const mode = c.req.query('mode') ?? undefined;
  const includeContext = c.req.query('context') === '1' || c.req.query('context') === 'true';
  const r = await buildResolvedPrompt(slug, role, mode, includeContext);
  if (r.error) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
  return c.json({
    department: slug,
    role,
    mode: mode ?? null,
    contextIncluded: includeContext,
    sections: r.sections,
    resolved: r.resolved,
    charLength: r.resolved.length,
  });
});

/**
 * Run the director agent: spawn claude -p with the resolved prompt + live context,
 * capture output, write a run record. Returns the agent's output.
 *
 * Body: { role?: 'orchestrator', mode?: 'ceo', timeoutMs?: 60000 }
 */

/**
 * Run the autonomous loop: orchestrator → (if NEXT_WORKER) worker → execute the
 * worker's ACTIONS block. Stops at DONE / ESCALATE / max iterations / per-step error.
 *
 * Body: { maxIterations?: 5, timeoutMsPerStep?: 90000 }
 */

// (activeRuns Map removed in Layer 3-A; legacy spawnClaude pipeline retired.)


/**
 * Execute one structured action emitted by a worker. Each op is implemented
 * in terms of the existing API surface (so charter validation runs).
 */
async function executeAction(action: any, callingDept?: string): Promise<any> {
  if (!action || typeof action !== 'object' || !action.op) {
    throw new Error('action missing op');
  }

  // Per-dept ACTION authorization (charter-symmetric with outboxKinds for messages).
  // Layer 2-B: read allowedActions from per-harness config (with fallback to departments.json)
  if (callingDept) {
    const roleCfg = getDeptRoleConfig(callingDept);
    if (!roleCfg) throw new Error(`unknown calling dept: ${callingDept}`);
    const allowed = roleCfg.allowedActions.length > 0 ? roleCfg.allowedActions : ['send_message', 'mark_message_status'];
    if (!allowed.includes(action.op)) {
      throw new Error(`${callingDept} not permitted to call op: ${action.op}. Allowed: ${allowed.join(', ')}`);
    }
  }

  switch (action.op) {
    case 'send_message': {
      // Inline the same logic as POST /messages, including charter validation.
      const depts = loadDepartments();
      const deptSlugs = depts.map((d) => d.slug);
      if (action.from !== 'user' && !deptSlugs.includes(action.from)) {
        throw new Error(`unknown from: ${action.from}`);
      }
      for (const t of (action.to ?? [])) {
        if (!deptSlugs.includes(t)) throw new Error(`unknown to: ${t}`);
      }
      if (action.from !== 'user') {
        // Layer 2-B: read outboxKinds from per-harness config
        const roleCfg = getDeptRoleConfig(action.from);
        if (!roleCfg) throw new Error(`unknown from: ${action.from}`);
        if (!roleCfg.outboxKinds.includes(action.kind)) {
          throw new Error(`${action.from} cannot emit kind=${action.kind}`);
        }
      }
      let projectId = action.projectId;
      if (!projectId) {
        if (action.kind === 'PlatformUpdate' || action.kind === 'Capability') projectId = PROJECT_PLATFORM;
        else projectId = PROJECT_ORG_OPS;
      } else {
        const proj = loadProjects().find((p) => p.id === projectId || p.slug === projectId);
        if (!proj) throw new Error(`unknown project: ${projectId}`);
        projectId = proj.id;
      }
      const msg: Message = {
        id: randomUUID(),
        ts: Date.now(),
        from: action.from,
        to: action.to ?? [],
        kind: action.kind,
        subject: action.subject ?? '(no subject)',
        body: action.body ?? '',
        refId: action.refId,
        projectId,
        directiveId: action.directiveId,
        status: 'pending',
        metadata: action.metadata,
      };
      await appendMessage(msg);
      return { sent: msg.id };
    }

    case 'mark_message_status': {
      const messages = loadMessages();
      const idx = messages.findIndex((m) => m.id === action.messageId);
      if (idx === -1) throw new Error(`message not found: ${action.messageId}`);
      messages[idx] = { ...messages[idx], status: action.status };
      await saveMessagesRebuild(messages);
      return { messageId: action.messageId, status: action.status };
    }

    case 'spinup_project': {
      // Execute via the directives projects flow
      const directives = loadDirectives();
      const dIdx = directives.findIndex((d) => d.id === action.directiveId);
      if (dIdx === -1) throw new Error(`directive not found: ${action.directiveId}`);
      const directive = directives[dIdx];

      const allProjects = loadProjects();
      const baseName = action.projectName?.trim() || directive.title;
      const baseSlugRaw = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
        || `directive-${directive.id.toLowerCase()}`;
      let slug = baseSlugRaw;
      let i = 2;
      while (allProjects.some((p) => p.slug === slug)) slug = `${baseSlugRaw}-${i++}`;

      const project: Project = {
        id: randomUUID(),
        slug,
        name: baseName,
        vertical: action.projectVertical?.trim() || 'apps',
        status: 'approved',
        owning_director: 'management',
        budget_cents: action.projectBudgetCents ?? 0,
        spent_cents: 0,
        created_ts: Date.now(),
        metadata: { sourceDirective: directive.id, additionalContext: action.additionalContext },
      };
      allProjects.push(project);
      await saveProjects(allProjects);

      directives[dIdx] = {
        ...directive,
        linkedProjectIds: [...(directive.linkedProjectIds ?? []), project.id],
      };

      // Kickoff + Priority + Budget messages
      const kickoff: Message = {
        id: randomUUID(),
        ts: Date.now(),
        from: 'management',
        to: ['business', 'rd', 'technology', 'marketing', 'management'],
        kind: 'ProjectKickoff',
        subject: `Project kickoff: ${project.name}`,
        body: `Project kicked off for directive ${directive.id}.\n\n- Slug: ${project.slug}\n- Vertical: ${project.vertical}\n- Budget: ${(project.budget_cents / 100).toFixed(2)}${action.additionalContext ? `\n- Scope: ${action.additionalContext}` : ''}`,
        projectId: project.id,
        directiveId: directive.id,
        status: 'pending',
      };
      await appendMessage(kickoff);

      const priorityMsg: Message = {
        id: randomUUID(),
        ts: Date.now(),
        from: 'business',
        to: action.departments && action.departments.length > 0 ? action.departments : ['management'],
        kind: 'Priority',
        subject: `Directive ${directive.id} → ${slug}: ${directive.title}`,
        body: `Directive **${directive.id}** routed to project **${slug}**.\n\nDirective: ${directive.body}${action.additionalContext ? `\n\nProject scope: ${action.additionalContext}` : ''}`,
        projectId: project.id,
        directiveId: directive.id,
        status: 'pending',
      };
      await appendMessage(priorityMsg);

      if (action.projectBudgetCents && action.projectBudgetCents > 0) {
        const budgetMsg: Message = {
          id: randomUUID(),
          ts: Date.now(),
          from: 'business',
          to: ['management'],
          kind: 'BudgetAllocation',
          subject: `Budget for ${slug}`,
          body: `Allocated ${(action.projectBudgetCents / 100).toFixed(2)} for project ${slug}.`,
          projectId: project.id,
          directiveId: directive.id,
          status: 'pending',
        };
        await appendMessage(budgetMsg);
      }

      directives[dIdx] = {
        ...directives[dIdx],
        assignedDepartments: Array.from(new Set([...(directives[dIdx].assignedDepartments ?? []), ...(action.departments ?? [])])),
      };
      await saveDirectives(directives);
      return { projectId: project.id, projectSlug: slug };
    }

    case 'add_directive_summary': {
      const summary: DirectiveSummary = {
        id: randomUUID(),
        directiveId: action.directiveId,
        ts: Date.now(),
        author: action.author ?? 'ceo',
        body: action.body ?? '',
      };
      await appendSummary(summary);
      return { summaryId: summary.id };
    }

    case 'mark_campaign_published': {
      // Marketing emits Campaign messages; this op transitions the original Campaign
      // message metadata to track publication state across ad networks.
      const messageId: string = action.messageId;
      if (!messageId) throw new Error('mark_campaign_published: messageId required');
      const channels: string[] = Array.isArray(action.channels) ? action.channels : [];
      const messages = loadMessages();
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx === -1) throw new Error(`mark_campaign_published: message not found: ${messageId}`);
      if (messages[idx].kind !== 'Campaign') throw new Error(`mark_campaign_published: message is not a Campaign (got ${messages[idx].kind})`);
      messages[idx] = {
        ...messages[idx],
        metadata: {
          ...(messages[idx].metadata ?? {}),
          campaignStatus: 'published',
          publishedTs: Date.now(),
          channels,
          impressions: action.impressions ?? 0,
          clicks: action.clicks ?? 0,
          installs: action.installs ?? 0,
        },
      };
      await saveMessagesRebuild(messages);
      await appendAudit('campaign.publish', messageId, { channels });
      return { published: true, messageId };
    }

    case 'pause_project': {
      const slug: string = action.projectSlug;
      if (!slug) throw new Error('pause_project: projectSlug required');
      const projects = loadProjects();
      const idx = projects.findIndex((p) => p.slug === slug || p.id === slug);
      if (idx === -1) throw new Error(`pause_project: project not found: ${slug}`);
      projects[idx] = { ...projects[idx], status: 'paused' };
      await saveProjects(projects);
      await appendAudit('project.pause', slug, { reason: action.reason ?? 'no reason given', by: action.by ?? 'autonomous' });
      return { paused: true, slug };
    }

    case 'resume_project': {
      const slug: string = action.projectSlug;
      if (!slug) throw new Error('resume_project: projectSlug required');
      const projects = loadProjects();
      const idx = projects.findIndex((p) => p.slug === slug || p.id === slug);
      if (idx === -1) throw new Error(`resume_project: project not found: ${slug}`);
      const newStatus = action.status ?? 'in_progress';
      projects[idx] = { ...projects[idx], status: newStatus };
      await saveProjects(projects);
      await appendAudit('project.resume', slug, { newStatus, by: action.by ?? 'autonomous' });
      return { resumed: true, slug, status: newStatus };
    }

    case 'scaffold_harness': {
      const slug: string = action.projectSlug;
      if (!slug) throw new Error('scaffold_harness: projectSlug required');
      const projects = loadProjects();
      const projIdx = projects.findIndex((p) => p.slug === slug || p.id === slug);
      if (projIdx === -1) throw new Error(`scaffold_harness: project not found: ${slug}`);
      const project = projects[projIdx];

      const harnessSlug: string = action.harnessSlug || project.slug;
      const harnessPath = action.harnessPath || join(homedir(), harnessSlug);

      // Refuse to overwrite existing harness
      if (existsSync(join(harnessPath, '.harness'))) {
        throw new Error(`scaffold_harness: harness already exists at ${harnessPath}`);
      }
      // Refuse if slug already in registry
      const REGISTRY_PATH = join(homedir(), '.restart-harness-projects.json');
      const registry = existsSync(REGISTRY_PATH)
        ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
        : { projects: [] };
      if (registry.projects.some((p: any) => p.slug === harnessSlug)) {
        throw new Error(`scaffold_harness: harness slug already registered: ${harnessSlug}`);
      }

      const template: 'web-app' | 'mobile-app' | 'service' = action.template || (
        project.vertical === 'mobile-app' ? 'mobile-app' :
        project.vertical === 'service' ? 'service' :
        'web-app'
      );

      const SPEC_TEMPLATES: Record<string, string> = {
        'web-app': `# Spec: ${project.name} — Phase 1 (MVP)\n\n## Goal\n\n${action.spec ?? 'Single-page web app, served on localhost. See GOAL.md for north star.'}\n\n## Scope (in)\n\n- (Planner: replace this with concrete acceptance criteria from the directive context.)\n\n## Scope (out for Phase 1)\n\n- Auth, multi-user, mobile, payments — defer until MVP works.\n\n## Tech\n\n- Next.js or Astro\n- TypeScript\n- Playwright for UI tests\n`,
        'mobile-app': `# Spec: ${project.name} — Phase 1 (MVP)\n\n## Goal\n\n${action.spec ?? 'Cross-platform mobile app for iOS + Android. See GOAL.md for north star.'}\n\n## Scope (in for Phase 1)\n\n- Single primary user flow that demonstrates the core value\n- Basic UI for that flow\n- Local persistence (no backend yet)\n- Buildable via EAS Build (no Mac required for iOS)\n\n## Scope (out for Phase 1)\n\n- Backend, auth, push notifications — defer until UI works.\n\n## Phase 2 — Monetization (when Phase 1 ships)\n\n- RevenueCat SDK integration (\`react-native-purchases\`) for cross-platform IAP\n- Single subscription tier or one-time unlock IAP\n- Receipt validation via RevenueCat's hosted endpoint\n- Wire revenue back to org via \`POST /api/org/projects/${project.slug}/record-revenue\`\n\n## Tech\n\n- Expo + React Native (cross-platform)\n- TypeScript\n- Expo Router for navigation\n- Maestro for end-to-end tests\n- EAS Build for cloud-signed iOS builds (no Mac needed)\n- RevenueCat for IAP (Phase 2)\n\n## Build verification\n\n- \`bin/build-mobile.sh\` (from \`~/autonomous-harness/bin/\`) runs \`eas build --profile preview --non-interactive\` for both platforms\n- Smoke gate: build artifacts produced for both \`.ipa\` and \`.aab\`\n- Requires \`eas-token\` secret set via \`PUT /api/org/secrets/eas-token\`\n\n## Toolchain setup (one-time per machine)\n\n\`~/autonomous-harness/bin/install-mobile-toolchain.sh\` — installs eas-cli, expo, maestro; checks ANDROID_HOME and required secrets.\n\n## Per-project setup (run once after this scaffold)\n\n\`cd ~/${project.slug} && ~/autonomous-harness/bin/init-mobile-project.sh\` — creates an Expo TypeScript starter (\`create-expo-app . --template blank-typescript\`), writes \`eas.json\` with build + submit profiles wired to the secrets layer, runs \`npm install\`.\n\n## Build + submit\n\n- \`~/autonomous-harness/bin/build-mobile.sh\` — submits iOS + Android preview builds to EAS Build (cloud).\n- \`~/autonomous-harness/bin/store-submit.sh\` — submits production builds to App Store Connect + Google Play Console via EAS Submit. Requires apple-id / asc-app-id / apple-app-store-connect-key / google-play-service-account secrets.\n`,
        'service': `# Spec: ${project.name} — Phase 1 (MVP)\n\n## Goal\n\n${action.spec ?? 'Headless backend service. See GOAL.md for north star.'}\n\n## Scope (in)\n\n- HTTP API with the minimum endpoints for the directive\n- Single in-process datastore (sqlite or json) at MVP\n\n## Scope (out for Phase 1)\n\n- Multi-instance, replication, queues, observability — defer.\n\n## Tech\n\n- Hono on Node.js or Bun\n- TypeScript\n- vitest for unit tests; curl smoke for service tests\n`,
      };

      const goalDefault = `# North Star\n\n${action.goal ?? `What ${project.name} should grow into. Filled in by the product role over time as scope expands.`}\n`;

      const configDefault = JSON.stringify({
        models: { planner: 'opus', worker: 'sonnet', validator: 'opus', orchestrator: 'haiku' },
        branchIsolation: { enabled: false },
        smokeTest: { enabled: false },
        scaffoldedFrom: { directiveId: project.metadata?.sourceDirective, projectId: project.id, template },
      }, null, 2) + '\n';

      // Create dirs + files
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(harnessPath, { recursive: true });
      mkdirSync(join(harnessPath, '.harness'), { recursive: true });
      writeFileSync(join(harnessPath, 'SPEC.md'), SPEC_TEMPLATES[template]);
      writeFileSync(join(harnessPath, 'GOAL.md'), goalDefault);
      writeFileSync(join(harnessPath, '.harness', 'config.json'), configDefault);

      // Register in harness-projects.json
      registry.projects.push({ slug: harnessSlug, path: harnessPath, harness_kind: 'coding' });
      writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');

      // Update project metadata
      projects[projIdx] = {
        ...project,
        metadata: {
          ...(project.metadata ?? {}),
          harness_slug: harnessSlug,
          harness_path: harnessPath,
          scaffolded_ts: Date.now(),
        },
      };
      await saveProjects(projects);

      await appendAudit('harness.scaffold', slug, { harnessSlug, harnessPath, template });

      return { harnessSlug, harnessPath, template };
    }

    default:
      throw new Error(`unknown op: ${action.op}`);
  }
}

/**
 * Emergency stop: kills every active claude process and disables every server-side
 * scheduler. Sets autoLoop=false on every dept's director-config.json so the state
 * is persisted (no zombie schedulers will be primed on next module load).
 */




/**
 * Composite snapshot for the Health dashboard.
 * Single-fetch substitute for ~6 separate calls so the page can poll cheaply.
 */

org.get('/:dept/cost-log', (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const path = join(homedir(), dept.harnessSlug, '.harness', 'cost-log.jsonl');
  if (!existsSync(path)) return c.json({ entries: [], total_cost_cents: 0 });
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  const total_cost_cents = entries.reduce((sum, e) => sum + (e.estimated_cost_cents ?? 0), 0);
  return c.json({ entries: entries.slice(-100), total_cost_cents, total_calls: entries.length });
});

org.get('/:dept/director-stats', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const runsDir = join(homedir(), dept.harnessSlug, '.harness', 'director-runs');
  if (!existsSync(runsDir)) return c.json({ runs: 0, byOutcome: {}, byKind: {}, avgRunsPerDay: 0 });
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(runsDir)).filter((f) => f.endsWith('.md'));
  const byOutcome: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const tsList: number[] = [];
  for (const f of files) {
    try {
      const content = await readFile(join(runsDir, f), 'utf8');
      const tsMatch = content.match(/- ts: (.+)/);
      if (tsMatch) {
        const t = new Date(tsMatch[1]).getTime();
        if (!isNaN(t)) tsList.push(t);
      }
      const dec = content.match(/- decisionKeyword: (.+)/);
      if (dec) byOutcome[dec[1].trim()] = (byOutcome[dec[1].trim()] ?? 0) + 1;
      const final = content.match(/- final: (.+)/);
      if (final) byOutcome[final[1].trim()] = (byOutcome[final[1].trim()] ?? 0) + 1;
      // Categorize by filename suffix: _orchestrator.md / _loop.md / _scheduler.md
      const m = f.match(/_(\w+)\.md$/);
      if (m) byKind[m[1]] = (byKind[m[1]] ?? 0) + 1;
    } catch {}
  }
  // runs-per-day estimate over the spread
  let avgRunsPerDay = 0;
  if (tsList.length > 1) {
    const sorted = tsList.sort((a, b) => a - b);
    const spanDays = Math.max(1, (sorted[sorted.length - 1] - sorted[0]) / 86_400_000);
    avgRunsPerDay = +(tsList.length / spanDays).toFixed(1);
  }
  return c.json({
    runs: files.length,
    byOutcome,
    byKind,
    avgRunsPerDay,
    earliest: tsList.length ? new Date(Math.min(...tsList)).toISOString() : null,
    latest: tsList.length ? new Date(Math.max(...tsList)).toISOString() : null,
  });
});

org.get('/:dept/memory', (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const limit = parseInt(c.req.query('limit') ?? '12', 10);
  const memory = synthesizeRecentMemory(dept.harnessSlug, isNaN(limit) ? 12 : Math.min(50, Math.max(1, limit)));
  return c.json({ deptSlug: slug, limit, ...memory });
});

org.get('/:dept/director-runs', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const runsDir = join(homedir(), dept.harnessSlug, '.harness', 'director-runs');
  if (!existsSync(runsDir)) return c.json({ runs: [] });
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(runsDir)).filter((f) => f.endsWith('.md')).sort().reverse();
  return c.json({
    runs: await Promise.all(files.slice(0, 30).map(async (f) => {
      const content = await readFile(join(runsDir, f), 'utf8');
      // Extract decision line and timestamp
      const tsMatch = content.match(/- ts: (.+)/);
      const decisionMatch = content.match(/- decisionKeyword: (.+)/);
      return {
        filename: f,
        ts: tsMatch?.[1] ?? null,
        decisionKeyword: decisionMatch?.[1] ?? null,
      };
    })),
  });
});

org.get('/:dept/director-runs/:filename', async (c) => {
  const slug = c.req.param('dept');
  const filename = c.req.param('filename');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.text('', 404);
  const path = join(homedir(), dept.harnessSlug, '.harness', 'director-runs', filename);
  if (!existsSync(path)) return c.text('', 404);
  // Prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) return c.text('', 400);
  const content = await readFile(path, 'utf8');
  return c.text(content);
});

// ================================================================
// Department routes — MUST come last because /:dept catches any
// single-segment slug and would shadow /projects, /directives, etc.
// ================================================================

org.get('/:dept', (c) => {
  const slug = c.req.param('dept');
  const depts = loadDepartments();
  const dept = depts.find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const messages = loadMessages();
  const inbox = messages.filter((m) => m.to.includes(slug));
  const outbox = messages.filter((m) => m.from === slug);
  return c.json({
    department: dept,
    inboxTotal: inbox.length,
    inboxPending: inbox.filter((m) => m.status === 'pending').length,
    outboxTotal: outbox.length,
    recentInbox: inbox.sort((a, b) => b.ts - a.ts).slice(0, 5),
    recentOutbox: outbox.sort((a, b) => b.ts - a.ts).slice(0, 5),
  });
});

org.get('/:dept/inbox', (c) => {
  const slug = c.req.param('dept');
  const messages = loadMessages().filter((m) => m.to.includes(slug));
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

org.get('/:dept/outbox', (c) => {
  const slug = c.req.param('dept');
  const messages = loadMessages().filter((m) => m.from === slug);
  return c.json({ messages: messages.sort((a, b) => b.ts - a.ts) });
});

org.get('/:dept/notes', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.text('', 404);
  const path = join(homedir(), dept.harnessSlug, '.harness', 'director-notes.md');
  if (!existsSync(path)) return c.text('', 404);
  const content = await readFile(path, 'utf8');
  return c.text(content);
});

org.put('/:dept/notes', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.json({ error: 'department not found' }, 404);
  const body = await c.req.text();
  const path = join(homedir(), dept.harnessSlug, '.harness', 'director-notes.md');
  await writeFile(path, body);
  return c.json({ ok: true });
});

org.get('/:dept/decisions', async (c) => {
  const slug = c.req.param('dept');
  const dept = loadDepartments().find((d) => d.slug === slug);
  if (!dept) return c.text('', 404);
  const path = join(homedir(), dept.harnessSlug, '.harness', 'decision-log.md');
  if (!existsSync(path)) return c.text('', 404);
  const content = await readFile(path, 'utf8');
  return c.text(content);
});
