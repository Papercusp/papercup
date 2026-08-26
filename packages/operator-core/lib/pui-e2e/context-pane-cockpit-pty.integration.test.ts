/**
 * Installed-binary real-PTY E2E for the pui Context-pane cockpit (WI-42179 /
 * plan pui-agent-context-cockpit-2026-08-26 P-008).
 *
 * Launches the ACTUAL `pui` binary (`pui context-pane <sourceKind> <sessionId>
 * <harness>`) under a real PTY (@lydell/node-pty) against a local fake
 * canonical HTTP operator (node:http), and asserts the terminal render + the
 * wire contract through the cockpit loop:
 *
 *  - projection fetch over `/api/zero-harness/rest-query?name=conversations.contextProjection`
 *  - claim → burn-down flip across fixture stages (refreshed with `g`)
 *  - typed block ref rendered ("blocked on WI-…") + server-side auto-unblock
 *  - task ops (`x` check · `d` drop · `Shift-P` promote · `u` clear blocker)
 *    → POST /api/harness/<h>/agent-chats/<chat>/tasks with {action, taskId},
 *    and the mutation response's canonical projection applied to the render
 *  - promote → the response projection carries the created work-item's
 *    `for`-edge link (links[] contract; the pane renders the task's blocker
 *    transition — link chips themselves are not part of the pane render)
 *  - read-only tier (codex target): task keys emit NO wire ops, footer
 *    degrades to "unavailable sections stay absent"
 *
 * The semantic tool cards / per-model-family alias shims are the CHAT-lane
 * (apps/tui/src/semantic_tool_cards.rs `card_for_tool` + `tool_name_is`) and
 * are unit-verified in that crate (`cargo test` in apps/tui); they do not
 * render in the Context pane, so they are deliberately not re-asserted here.
 *
 * Binary resolution: $PUI_BIN → `cargo metadata` target dir → common target
 * paths → $PATH. If absent, the suite builds it (`cargo build --bin pui`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');
const HARNESS = 'papercusp';
const CHAT_ID = 'chat-e2e';

// ─── binary resolution ────────────────────────────────────────────────────────

function cargoTargetDir(): string | null {
  const probe = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  try {
    return (JSON.parse(probe.stdout) as { target_directory?: string }).target_directory ?? null;
  } catch {
    return null;
  }
}

function resolvePuiBinary(): string | null {
  const candidates: Array<string | null | undefined> = [process.env.PUI_BIN];
  const targetDir = cargoTargetDir();
  if (targetDir) {
    candidates.push(path.join(targetDir, 'debug', 'pui'), path.join(targetDir, 'release', 'pui'));
  }
  candidates.push(
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
    path.join(TUI_DIR, 'target', 'release', 'pui'),
    path.join(REPO_ROOT, 'target', 'debug', 'pui'),
    path.join(REPO_ROOT, 'target', 'release', 'pui'),
  );
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  const which = spawnSync('which', ['pui'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function ensurePuiBinary(): string {
  const found = resolvePuiBinary();
  if (found) return found;
  const build = spawnSync('cargo', ['build', '--bin', 'pui'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 840_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    throw new Error(`cargo build --bin pui failed:\n${build.stderr?.slice(-4000)}`);
  }
  const built = resolvePuiBinary();
  if (!built) throw new Error('pui binary not found even after cargo build');
  return built;
}

// ─── projection fixtures ──────────────────────────────────────────────────────

type TaskFixture = {
  id: string;
  content: string;
  activeForm: string;
  status: string;
  blockerRef?: string | null;
  links?: Array<{ workItemId: string; workItemHarness?: string; relation: 'for' | 'relates' }>;
};

function taskFrame(t: TaskFixture, position: number) {
  return {
    kind: 'task',
    id: `task:${t.id}`,
    taskId: t.id,
    content: t.content,
    activeForm: t.activeForm,
    status: t.status,
    blockerRef: t.blockerRef ?? null,
    explanation: null,
    position,
    updatedAt: '2026-08-26T22:00:00Z',
    links: t.links ?? [],
  };
}

function makeProjection(opts: {
  sourceKind: string;
  sessionId: string;
  tier: string;
  taskWrite: boolean;
  burnDown: string;
  claim: { value: string; state: string };
  tasks: TaskFixture[];
  approvals?: Array<{ callId: string; toolName: string; status: string; reason?: string }>;
}) {
  return {
    schemaVersion: 'conversation-context-v1',
    session: {
      sourceKind: opts.sourceKind,
      sessionId: opts.sessionId,
      harness: HARNESS,
      role: 'sentinel',
      linkedWorkItemId: 'WI-42179',
      capabilityTier: opts.tier,
    },
    capabilities: {
      liveFrames: true,
      taskWrite: opts.taskWrite,
      approvalWrite: opts.taskWrite,
    },
    frames: [
      {
        kind: 'context',
        id: 'context:identity',
        section: 'identity',
        title: 'Identity',
        entries: [{ label: 'Session', value: opts.sessionId, state: null, badges: [] }],
      },
      {
        kind: 'context',
        id: 'context:work',
        section: 'work',
        title: 'Work',
        entries: [
          { label: 'Burn-down', value: opts.burnDown, state: null, badges: [] },
          { label: 'Claim', value: opts.claim.value, state: opts.claim.state, badges: [] },
        ],
      },
      ...opts.tasks.map((t, i) => taskFrame(t, i)),
      ...(opts.approvals ?? []).map((a) => ({
        kind: 'approval',
        id: `approval:${a.callId}`,
        callId: a.callId,
        toolName: a.toolName,
        status: a.status,
        reason: a.reason ?? null,
      })),
    ],
  };
}

// ─── fake canonical operator ──────────────────────────────────────────────────

type RecordedQuery = { name: string; args: Record<string, unknown> };
type RecordedTaskOp = { path: string; body: Record<string, unknown> };

class FakeOperator {
  server: Server;
  port = 0;
  /** rows served for the projection query, keyed by sessionId */
  projections = new Map<string, unknown>();
  /** projection returned inside the NEXT task-op mutation response */
  mutationProjection: unknown = null;
  queries: RecordedQuery[] = [];
  taskOps: RecordedTaskOp[] = [];
  private sockets = new Set<Socket>();

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const send = (value: unknown, status = 200) => {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      };
      if (url.pathname === '/api/tui/identity') {
        send({
          schemaVersion: 1,
          workspaceId: 'ws-e2e',
          store: { id: 'store-e2e', target: 'pg', source: 'e2e' },
          build: { version: '0.0.0-e2e', sha: null },
          agentChat: { scope: 'workspace:ws-e2e', route: '/api/harness' },
        });
        return;
      }
      if (url.pathname === '/api/zero-harness/rest-query') {
        const name = url.searchParams.get('name') ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(url.searchParams.get('args') ?? '{}');
        } catch {
          /* keep {} */
        }
        this.queries.push({ name, args });
        if (name === 'conversations.contextProjection') {
          const projection = this.projections.get(String(args.sessionId ?? ''));
          send({ rows: projection ? [projection] : [], version: 1 });
          return;
        }
        send({ rows: [], version: 1 });
        return;
      }
      // Any SSE subscription: hold the stream open with a heartbeat comment.
      if (url.pathname.includes('/sse') || (req.headers.accept ?? '').includes('text/event-stream')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': heartbeat\n\n');
        return; // never ended; sockets are destroyed in close()
      }
      if (req.method === 'POST' && /^\/api\/harness\/[^/]+\/agent-chats\/[^/]+\/tasks$/.test(url.pathname)) {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            /* keep {} */
          }
          this.taskOps.push({ path: url.pathname, body });
          send({
            ok: true,
            action: body.action ?? 'check',
            op: String(body.action ?? 'check'),
            changedTaskId: body.taskId ?? null,
            tasks: [],
            projection: this.mutationProjection,
          });
        });
        return;
      }
      // Everything else: benign empties — the pui DTOs default missing fields.
      send({ rows: [], ok: true });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ─── PTY harness ──────────────────────────────────────────────────────────────

// ratatui renders via cursor-jump DIFFS — only CHANGED cells are rewritten —
// so strip-ANSI-flattening the raw stream drops characters that were already
// on screen and mangles words ("owned-loop" → "owned-oop"). Maintain a real
// screen grid instead: interpret cursor positioning + erase sequences and
// assert against the RENDERED screen, the way a user reads it.
// ESC written as \x1b escapes on purpose — a raw 0x1b byte in source trips
// lint:no-control-bytes (a green-checkpoint leg). Runtime-identical.
const ESC = '\x1b';

class VtScreen {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;

  constructor(
    private rows: number,
    private cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  }

  private clamp(v: number, max: number): number {
    return Math.max(0, Math.min(v, max));
  }

  private clearAll(): void {
    for (const r of this.grid) r.fill(' ');
  }

  private clearRow(r: number, from: number, to: number): void {
    for (let c = from; c < to; c++) this.grid[r][c] = ' ';
  }

  private lineFeed(): void {
    this.row++;
    if (this.row >= this.rows) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.cols).fill(' '));
      this.row = this.rows - 1;
    }
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    this.col++;
  }

  private csi(params: string, final: string): void {
    const isPrivate = params.startsWith('?');
    const nums = (isPrivate ? params.slice(1) : params)
      .split(';')
      .map((p) => parseInt(p, 10))
      .map((v) => (Number.isFinite(v) ? v : 0));
    const p0 = nums[0] ?? 0;
    switch (final) {
      case 'H':
      case 'f':
        this.row = this.clamp((nums[0] || 1) - 1, this.rows - 1);
        this.col = this.clamp((nums[1] || 1) - 1, this.cols - 1);
        break;
      case 'A':
        this.row = this.clamp(this.row - (p0 || 1), this.rows - 1);
        break;
      case 'B':
        this.row = this.clamp(this.row + (p0 || 1), this.rows - 1);
        break;
      case 'C':
        this.col = this.clamp(this.col + (p0 || 1), this.cols - 1);
        break;
      case 'D':
        this.col = this.clamp(this.col - (p0 || 1), this.cols - 1);
        break;
      case 'G':
        this.col = this.clamp((p0 || 1) - 1, this.cols - 1);
        break;
      case 'd':
        this.row = this.clamp((p0 || 1) - 1, this.rows - 1);
        break;
      case 'J':
        if (p0 === 2 || p0 === 3) this.clearAll();
        else if (p0 === 1) {
          for (let r = 0; r < this.row; r++) this.clearRow(r, 0, this.cols);
          this.clearRow(this.row, 0, this.col + 1);
        } else {
          this.clearRow(this.row, this.col, this.cols);
          for (let r = this.row + 1; r < this.rows; r++) this.clearRow(r, 0, this.cols);
        }
        break;
      case 'K':
        if (p0 === 2) this.clearRow(this.row, 0, this.cols);
        else if (p0 === 1) this.clearRow(this.row, 0, this.col + 1);
        else this.clearRow(this.row, this.col, this.cols);
        break;
      case 'h':
      case 'l':
        // Alt-screen enter/leave → fresh screen, home cursor. Every other
        // mode (cursor visibility, mouse, bracketed paste) has no grid effect.
        if (isPrivate && nums.includes(1049)) {
          this.clearAll();
          this.row = 0;
          this.col = 0;
        }
        break;
      default:
        break; // SGR (m), scroll region (r), … — no grid effect
    }
  }

  /**
   * Feed the WHOLE raw stream, parsing from scratch — chunk-split escape
   * sequences and an incomplete tail then can never be mis-parsed (an
   * incomplete trailing sequence is simply left for the next parse).
   */
  feed(data: string): void {
    let i = 0;
    const n = data.length;
    while (i < n) {
      const ch = data[i];
      if (ch === ESC) {
        const kind = data[i + 1];
        if (kind === undefined) break; // incomplete tail
        if (kind === '[') {
          let j = i + 2;
          while (j < n && !(data[j] >= '@' && data[j] <= '~')) j++;
          if (j >= n) break; // incomplete CSI tail
          this.csi(data.slice(i + 2, j), data[j]);
          i = j + 1;
        } else if (kind === ']') {
          // OSC: consume through BEL or ST (ESC \)
          let j = i + 2;
          while (j < n && data[j] !== '\x07' && !(data[j] === ESC && data[j + 1] === '\\')) j++;
          if (j >= n) break; // incomplete OSC tail
          i = data[j] === '\x07' ? j + 1 : j + 2;
        } else if (kind === '7') {
          this.savedRow = this.row;
          this.savedCol = this.col;
          i += 2;
        } else if (kind === '8') {
          this.row = this.savedRow;
          this.col = this.savedCol;
          i += 2;
        } else if (kind === '(' || kind === ')') {
          i += 3; // charset designation: ESC ( X
        } else {
          i += 2; // ESC =, ESC >, …
        }
        continue;
      }
      if (ch === '\n') this.lineFeed();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = this.clamp(this.col - 1, this.cols - 1);
      else if (ch === '\t') this.col = this.clamp((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
      else if (ch >= ' ' && ch !== '\x7f') this.put(ch);
      i++;
    }
  }

  text(): string {
    return this.grid.map((r) => r.join('').trimEnd()).join('\n');
  }
}

class PuiPane {
  pty: IPty;
  private raw = '';

  constructor(bin: string, args: string[], env: Record<string, string>) {
    this.pty = ptySpawn(bin, args, {
      name: 'xterm-256color',
      cols: 140,
      rows: 40,
      cwd: REPO_ROOT,
      env,
    });
    this.pty.onData((chunk) => {
      this.raw += chunk;
    });
  }

  /** The RENDERED screen: 40 rows × 140 cols, right-trimmed, newline-joined. */
  screen(): string {
    const vt = new VtScreen(40, 140);
    vt.feed(this.raw);
    return vt.text();
  }

  /**
   * Substring match against the whitespace-NORMALIZED rendered screen (runs of
   * spaces collapse per row), so a column-aligned layout ("Burn-down   2/5")
   * still matches a single-spaced needle. Needles never span rows.
   */
  contains(needle: string): boolean {
    const normalized = this.screen()
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .join('\n');
    return normalized.includes(needle.replace(/\s+/g, ' ').trim());
  }

  async waitFor(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.contains(needle)) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error(
      `timed out (${timeoutMs}ms) waiting for ${JSON.stringify(needle)} on the rendered screen:\n${this.screen()}`,
    );
  }

  write(keys: string): void {
    this.pty.write(keys);
  }

  kill(): void {
    try {
      this.pty.kill();
    } catch {
      /* already dead */
    }
  }
}

function paneEnv(operatorPort: number, home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PUI_OPERATOR: `http://127.0.0.1:${operatorPort}`,
    // Deliberately NOT inheriting PAPERCUSP_OPERATOR_URL / ZELLIJ etc. — a
    // conflicting operator selector makes the binary bail out at startup.
  };
}

// ─── the suite ────────────────────────────────────────────────────────────────

let bin: string;
let operator: FakeOperator;
let tempHome: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  bin = ensurePuiBinary();
  tempHome = mkdtempSync(path.join(tmpdir(), 'pui-e2e-home-'));
  // Pre-seed the first-run tutorial as seen so its overlay does not eat keys.
  mkdirSync(path.join(tempHome, '.papercusp'), { recursive: true });
  writeFileSync(
    path.join(tempHome, '.papercusp', 'pui-state.json'),
    JSON.stringify({ tutorialSeen: true }),
  );
  operator = new FakeOperator();
  await operator.listen();
}, 900_000);

afterAll(async () => {
  await operator?.close();
});

describe('pui context-pane cockpit (installed binary, real PTY, fake canonical operator)', () => {
  test(
    'owned-loop cockpit: claim → burn-down flip, auto-unblock, task ops wire + render, promote for-edge, g refresh',
    async () => {
      operator.queries = [];
      operator.taskOps = [];
      operator.projections.delete(CHAT_ID);

      const pane = new PuiPane(bin, ['context-pane', 'agent_chat', CHAT_ID, HARNESS], paneEnv(operator.port, tempHome));
      try {
        // Boot: explicit target, no projection rows yet → explicit degradation.
        await pane.waitFor('does not expose Context', { timeoutMs: 30_000 });

        // ── Stage A: initial projection ─────────────────────────────────────
        const tasksA: TaskFixture[] = [
          { id: 't1', content: 'Wire the cockpit E2E', activeForm: 'Wiring the cockpit E2E', status: 'in_progress' },
          { id: 't2', content: 'Verify blocker clears', activeForm: 'Verifying blocker clears', status: 'blocked', blockerRef: 'WI-9001' },
          { id: 't3', content: 'Drop this decoy task', activeForm: 'Dropping the decoy task', status: 'pending' },
          { id: 't4', content: 'Promote me to a work-item', activeForm: 'Promoting to a work-item', status: 'pending' },
        ];
        operator.projections.set(
          CHAT_ID,
          makeProjection({
            sourceKind: 'agent_chat',
            sessionId: CHAT_ID,
            tier: 'owned-loop',
            taskWrite: true,
            burnDown: '2/5 open',
            claim: { value: 'unclaimed', state: 'waiting' },
            tasks: tasksA,
            approvals: [{ callId: 'call-1', toolName: 'locks:acquire', status: 'pending', reason: 'requested' }],
          }),
        );
        pane.write('g');
        await pane.waitFor('Context · owned-loop');
        await pane.waitFor('task write');
        await pane.waitFor('Burn-down');
        await pane.waitFor('2/5 open');
        await pane.waitFor('unclaimed');
        // in_progress renders the activeForm; blocked renders content + typed block ref
        await pane.waitFor('Wiring the cockpit E2E');
        await pane.waitFor('blocked on WI-9001');
        await pane.waitFor('Tasks (4)');
        // approvals surface
        await pane.waitFor('Needs you (1)');
        await pane.waitFor('locks:acquire');
        // writable footer
        await pane.waitFor('Shift-P promote');

        // The wire was queried with the typed target.
        const projQueries = operator.queries.filter((q) => q.name === 'conversations.contextProjection');
        expect(projQueries.length).toBeGreaterThan(0);
        expect(projQueries.at(-1)!.args).toMatchObject({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          harness: HARNESS,
        });

        // ── Stage B: claim lands server-side → burn-down flips; blocker WI resolves → auto-unblock ──
        const tasksB: TaskFixture[] = [
          tasksA[0],
          { ...tasksA[1], status: 'in_progress', blockerRef: null },
          tasksA[2],
          tasksA[3],
        ];
        operator.projections.set(
          CHAT_ID,
          makeProjection({
            sourceKind: 'agent_chat',
            sessionId: CHAT_ID,
            tier: 'owned-loop',
            taskWrite: true,
            burnDown: '3/5 open',
            claim: { value: 'su-e2e · claimed', state: 'live' },
            tasks: tasksB,
            approvals: [],
          }),
        );
        pane.write('g');
        await pane.waitFor('3/5 open');
        await pane.waitFor('su-e2e · claimed');
        // auto-unblock: t2 now renders its in_progress activeForm, with no block ref
        await pane.waitFor('Verifying blocker clears');
        // …and the stale typed block ref is no longer anywhere on the screen.
        expect(pane.contains('blocked on WI-9001')).toBe(false);

        // ── Task op: x = check (selected task index 0 → t1) ─────────────────
        operator.mutationProjection = makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '3/5 open',
          claim: { value: 'su-e2e · claimed', state: 'live' },
          tasks: [{ ...tasksB[0], status: 'completed' }, tasksB[1], tasksB[2], tasksB[3]],
        });
        pane.write('x');
        await pane.waitFor('Wire the cockpit E2E'); // completed renders content form ("Wiring…" → "Wire…")
        expect(operator.taskOps.at(-1)).toMatchObject({
          path: `/api/harness/${HARNESS}/agent-chats/${CHAT_ID}/tasks`,
          body: { action: 'check', taskId: 't1' },
        });

        // ── Task op: d = drop (nav j j → t3) ────────────────────────────────
        operator.mutationProjection = makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '3/5 open',
          claim: { value: 'su-e2e · claimed', state: 'live' },
          tasks: [
            { ...tasksB[0], status: 'completed' },
            tasksB[1],
            { ...tasksB[2], status: 'dropped' },
            tasksB[3],
          ],
        });
        pane.write('jj');
        await sleep(200);
        pane.write('d');
        const dropDeadline = Date.now() + 15_000;
        while (Date.now() < dropDeadline && operator.taskOps.at(-1)?.body.action !== 'drop') {
          await sleep(60);
        }
        expect(operator.taskOps.at(-1)).toMatchObject({ body: { action: 'drop', taskId: 't3' } });

        // ── Task op: Shift-P = promote (nav j → t4); response carries the for-edge ──
        operator.mutationProjection = makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '3/5 open',
          claim: { value: 'su-e2e · claimed', state: 'live' },
          tasks: [
            { ...tasksB[0], status: 'completed' },
            tasksB[1],
            { ...tasksB[2], status: 'dropped' },
            {
              ...tasksB[3],
              status: 'blocked',
              blockerRef: 'WI-7777',
              links: [{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }],
            },
          ],
        });
        pane.write('j');
        await sleep(200);
        pane.write('P');
        await pane.waitFor('blocked on WI-7777');
        const promoteOp = operator.taskOps.at(-1)!;
        expect(promoteOp).toMatchObject({ body: { action: 'promote', taskId: 't4' } });
        // The canonical projection the operator returned for the promote carries
        // the created work-item's `for` edge; the pane applied that projection
        // (the WI-7777 block ref just asserted comes from it).
        const promoted = (operator.mutationProjection as { frames: Array<Record<string, unknown>> }).frames.find(
          (f) => f.kind === 'task' && (f as { taskId?: string }).taskId === 't4',
        ) as { links: Array<{ workItemId: string; relation: string }> };
        expect(promoted.links).toEqual([{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }]);

        // ── Task op: u = clear blocker (still on t4) ────────────────────────
        operator.mutationProjection = makeProjection({
          sourceKind: 'agent_chat',
          sessionId: CHAT_ID,
          tier: 'owned-loop',
          taskWrite: true,
          burnDown: '3/5 open',
          claim: { value: 'su-e2e · claimed', state: 'live' },
          tasks: [
            { ...tasksB[0], status: 'completed' },
            tasksB[1],
            { ...tasksB[2], status: 'dropped' },
            {
              ...tasksB[3],
              status: 'in_progress',
              activeForm: 'Unblocked and rolling',
              blockerRef: null,
              links: [{ workItemId: 'WI-7777', workItemHarness: HARNESS, relation: 'for' }],
            },
          ],
        });
        pane.write('u');
        await pane.waitFor('Unblocked and rolling');
        expect(operator.taskOps.at(-1)).toMatchObject({ body: { action: 'clear_blocker', taskId: 't4' } });
      } finally {
        pane.kill();
      }
    },
    180_000,
  );

  test(
    'codex target is read-only: degraded footer, and task keys emit no wire ops',
    async () => {
      operator.queries = [];
      operator.taskOps = [];
      const SESSION = 'rollout-x';

      const pane = new PuiPane(bin, ['context-pane', 'codex', SESSION, HARNESS], paneEnv(operator.port, tempHome));
      try {
        await pane.waitFor('does not expose Context', { timeoutMs: 30_000 });

        operator.projections.set(
          SESSION,
          makeProjection({
            sourceKind: 'codex',
            sessionId: SESSION,
            tier: 'shared-projection',
            taskWrite: false,
            burnDown: '1/2 open',
            claim: { value: 'foreign session', state: 'parked' },
            tasks: [{ id: 'c1', content: 'Codex-side task', activeForm: 'Codex-side task running', status: 'in_progress' }],
          }),
        );
        pane.write('g');
        await pane.waitFor('Context · shared-projection');
        await pane.waitFor('tasks read-only');
        await pane.waitFor('unavailable sections stay absent');
        await pane.waitFor('Codex-side task running');

        // The typed target rode the query.
        const projQueries = operator.queries.filter((q) => q.name === 'conversations.contextProjection');
        expect(projQueries.at(-1)!.args).toMatchObject({ sourceKind: 'codex', sessionId: SESSION });

        // Task keys on a read-only (non-agent_chat) target emit NO mutations.
        const opsBefore = operator.taskOps.length;
        pane.write('x');
        pane.write('d');
        pane.write('P');
        pane.write('u');
        await sleep(700);
        expect(operator.taskOps.length).toBe(opsBefore);
      } finally {
        pane.kill();
      }
    },
    120_000,
  );
});
