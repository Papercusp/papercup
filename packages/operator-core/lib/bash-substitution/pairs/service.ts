/**
 * Equivalence pairs — the SERVICE family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-009).
 *
 * Population in the 7d corpus: 709 `systemctl` atoms across 50 sessions, 493
 * `curl` across 51, and 138 socket queries (`ss` 100 / `lsof` 38 / `netstat` 2)
 * across ~30. Proposed replacements: `dev:service_health` (read) and
 * `dev:restart` (write).
 *
 * ── The capability envelope, read from the tools ─────────────────────────────
 * `dev:service_health` takes `z.object({})` — NO arguments at all. It returns a
 * FIXED payload:
 *   • `services[]` — one probe per entry in `HEALTH_ENDPOINTS` plus four
 *     portless/opt-in probes. Only these carry an `up` verdict:
 *       operator (http://127.0.0.1:3070/api/desktop/version)
 *       vite (:3055, onDemand) · scout (:3350) · embed-sidecar (:3384, opt-in)
 *       desktop · bg-host-ticker · bg-host-code · substrate-sidecar (portless)
 *   • `supervision[]` — one row per `SUPERVISED_PROCESSES` entry. THE DECISIVE
 *     DETAIL: a supervision row carries `flapState` / `restartsLast10m` /
 *     `consecutiveProbeFailures` / `secondsSinceStart` and **no up-or-down
 *     field**. It describes restart CHURN, not liveness. Worse, a genuinely
 *     stopped unit and a failed probe are indistinguishable: both leave
 *     `secondsSinceStart` undefined, because `overlaySystemdRestartRecency`
 *     returns the entry untouched for `MainPID 0` exactly as it does for a probe
 *     error. So `supervision[]` cannot answer `systemctl is-active` for ANY unit.
 *
 * The practical consequence: of the seven systemd units in the supervision
 * registry, only `papercup-dev-api` (→ `operator`), `papercup-bg-host` (→
 * `bg-host-ticker`) and `papercup-embed-sidecar` (→ `embed-sidecar`) have a
 * liveness answer at all, and they have it because something PROBES them, not
 * because they are in the registry. `papercup-staging-api`,
 * `papercup-inference-gateway`, `papercup-mcp-proxy` and
 * `papercup-live-federation-gate` are supervised but unprobed — the tool returns
 * a row about them that says nothing about whether they are running.
 *
 * `dev:restart` takes `target: 'dev' | 'staging' | 'gateway' | 'bg-host' |
 * 'embed-sidecar'` and only ever RESTARTS (`systemctl --user restart <unit>`);
 * there is no start, no stop, no daemon-reload, no reset-failed.
 *
 * ── What the corpus asks for, bucketed by QUESTION ───────────────────────────
 * systemctl (709 atoms), by verb:
 *   234 (33.0%)  inventory / schedule   `list-timers` (174), `list-units` (60)
 *   188 (26.5%)  unit CONFIG            `show -p …` (122), `cat` (60), `list-unit-files` (3)
 *   145 (20.5%)  state + journal tail   `status`
 *    93 (13.1%)  boolean liveness       `is-active` (89), `is-failed` (4)
 *    41 ( 5.8%)  lifecycle WRITE        `restart` (32), `start` (5), `stop` (4)
 *     8 ( 1.1%)  other                  `daemon-reload`, `reset-failed`, …
 *
 * Only the fourth bucket is the question `dev:service_health` is shaped to
 * answer, and only the fifth is `dev:restart`'s. Three of the five name a
 * capability neither tool has at all — `systemctl show -p NRestarts`,
 * `systemctl cat`, and `systemctl list-timers` have no tool form whatsoever,
 * and together they are 422 atoms, 59% of the family.
 *
 * ── Three pairs, drawn on the intent boundaries ──────────────────────────────
 * Per D-008 the pattern is the unit of enforcement, so each pair claims exactly
 * one question:
 *   `service.systemctl-is-active`  — is this unit up? (boolean liveness)
 *   `service.curl-health-probe`    — is this local port answering?
 *   `service.listening-ports`      — what is listening / who owns this port?
 *
 * Two candidate pairs were considered and deliberately NOT written:
 *
 *   `systemctl status` (145 atoms) is EXCLUDED from the liveness pair rather
 *   than folded into it. `status` returns ActiveState AND the unit's last
 *   journal lines, and 21 of its distinct shapes pass `-n <N>` asking for
 *   exactly those lines. `dev:service_health` returns no journal at all, so
 *   enforcing a liveness advisory over `status` would answer a question the
 *   agent did not ask. That bucket routes to P-013 (unit coverage) and P-023
 *   (`logs:read`), not here. This narrowing does not flatter the verdict: the
 *   pair lands `needs-widening` either way, because most probed units have no
 *   liveness answer regardless of which verb asked.
 *
 *   `systemctl restart|start|stop` → `dev:restart` earned NO pair, because the
 *   corpus cannot support one: 41 atoms but only **11 distinct shapes** across 9
 *   sessions, under `MIN_SAMPLE_SIZE`, so `auditPair` rightly refuses a verdict.
 *   That scarcity is itself the finding — see `SERVICE_LIFECYCLE_WRITE_FINDING`.
 */

import type { CoverageResult, SubstitutionPair } from '../types';

/**
 * Local ports `dev:service_health` actually probes, with the `services[]` entry
 * each one reports as. Duplicated from `HEALTH_ENDPOINTS` /
 * `probeEmbedSidecar` deliberately — this is a MODEL of the tool used to score
 * coverage, and if the real endpoint list changes the recomputed verdict must
 * change with it rather than silently tracking a shared constant. The
 * `expectedVerdict` latch is what surfaces the divergence.
 */
const PROBED_PORTS: Record<string, string> = {
  '3070': 'operator',
  '3055': 'vite',
  '3350': 'scout',
  '3384': 'embed-sidecar',
};

/**
 * systemd units whose liveness `dev:service_health` can actually answer, and the
 * `services[]` probe that answers it. Note NONE of these is answered by the
 * `supervision[]` block — they are answered because something probes them.
 */
const UNIT_TO_PROBE: Record<string, string> = {
  'papercup-dev-api': 'operator',
  'papercup-bg-host': 'bg-host-ticker',
  'papercup-embed-sidecar': 'embed-sidecar',
};

/**
 * Units that ARE in `SUPERVISED_PROCESSES` but have no probe. The tool returns a
 * row for each — carrying flap/restart counters only — so it looks like an
 * answer and is not one. Separated from "unknown unit" in the failure reasons
 * because the remedy differs: these need a PROBE (P-013), not registration.
 */
const SUPERVISED_BUT_UNPROBED = new Set([
  'papercup-staging-api',
  'papercup-inference-gateway',
  'papercup-mcp-proxy',
  'papercup-live-federation-gate',
  'papercup-live-federation-gate.timer',
]);

/** Strip `.service`, a trailing redirect, and quoting from a unit token. */
function normalizeUnit(raw: string): string {
  return raw
    .replace(/^["']|["']$/g, '')
    .replace(/\.service$/, '')
    .trim();
}

/**
 * The unit a `systemctl <verb> …` atom names: the first token after the verb
 * that is not a flag, a redirect, or a shell fragment. Returns null when the
 * atom names no resolvable unit (a glob, a `$(…)` substitution, a bare verb).
 */
export function systemctlUnit(atom: string): string | null {
  const match = /^systemctl\s+((?:--?\S+\s+)*)(\S+)\s*(.*)$/.exec(atom);
  if (!match) return null;
  for (const token of match[3].trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('-')) continue;
    if (/^[$|>&]/.test(token) || /^\d?>/.test(token)) continue;
    if (token.includes('*')) return null;
    return normalizeUnit(token);
  }
  return null;
}

/** The `http://host:port/path` a curl atom targets, if it has one. */
export function curlTarget(atom: string): { port: string; path: string } | null {
  const match = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?(\/[^\s'"`]*)?/.exec(atom);
  if (!match) return null;
  return { port: match[1] ?? '80', path: match[2] ?? '/' };
}

/** curl was told to throw the response body away — it wants only liveness. */
const DISCARDS_BODY = /-o\s+\/dev\/null\b/;

/**
 * P-009 — "is this unit up?" → `dev:service_health`.
 *
 * Scoped to the boolean-liveness verbs (`is-active`, `is-failed`) for the reason
 * given in the header: `status` additionally asks for the journal tail, which
 * this tool cannot produce, so folding it in would enforce an advisory against a
 * question the tool does not answer.
 *
 * The `UNIT_TO_PROBE` branch in `cover()` is the genuine overlap and is what
 * keeps this envelope honest — if the corpus were mostly `is-active
 * papercup-dev-api` this pair would score `equivalent` and the audit would say
 * so. It does not: the units agents actually ask about are the ones nothing
 * probes.
 */
export const systemctlIsActive: SubstitutionPair = {
  id: 'service.systemctl-is-active',
  intentLabel: 'unit-liveness-query',
  bashPattern: /^systemctl\s+(?:--\S+\s+)*(?:is-active|is-failed)\b/,
  toolName: 'dev:service_health',
  advisoryText:
    'dev:service_health reports up/down ONLY for what it probes (operator :3070, vite :3055, scout :3350, embed-sidecar :3384, plus the portless desktop/bg-host probes). Its supervision[] block carries restart-churn counters and NO up-or-down field, so it cannot answer is-active for staging-api, the inference gateway, mcp-proxy, the federation gate, or any unit outside the registry. Keep using systemctl for those.',
  routing: {
    want: 'whether a systemd unit is currently active',
    use: '`dev:service_health` — only for the probed set (operator/vite/scout/embed-sidecar/bg-host)',
    insteadOf: '`systemctl --user is-active <unit>` — still required for every other unit; supervision[] has no liveness field',
  },
  expectedVerdict: 'needs-widening',
  cover(atom: string): CoverageResult {
    const unit = systemctlUnit(atom);
    if (!unit) {
      return {
        covered: false,
        reason: 'names no resolvable unit (glob or shell substitution); dev:service_health takes no arguments and cannot be pointed at one',
      };
    }
    const probe = UNIT_TO_PROBE[unit];
    if (probe) {
      return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probe}').up` };
    }
    if (SUPERVISED_BUT_UNPROBED.has(unit)) {
      return {
        covered: false,
        reason: `${unit} is in SUPERVISED_PROCESSES but nothing probes it — dev:service_health returns a supervision row with flap counters and no up/down field`,
      };
    }
    return {
      covered: false,
      reason: `${unit} is outside the supervision registry and the probe list entirely — dev:service_health has no argument to name it`,
    };
  },
};

/**
 * P-009 — "is this local port answering?" → `dev:service_health`.
 *
 * Two independent ways to fail, and the corpus supplies both in bulk:
 *   • the PORT is not probed (`:3170` staging, `:3270`, `:8788` gateway,
 *     `:46229`, `:18071`…) — the tool has no argument to add one; and
 *   • the BODY is wanted, not the status code. `curl … /api/health` without
 *     `-o /dev/null` is read for its payload (pool state, build sha, queue
 *     depths); `dev:service_health` returns its OWN diagnostic shape and never
 *     that body, so substituting it silently answers a different question.
 *
 * `:3170` is the sharpest single finding in this family. `CLAUDE.md` instructs
 * every agent to verify a staging edit by restarting `:3170` and probing it —
 * and `:3170` is not in `HEALTH_ENDPOINTS`, so the documented workflow has no
 * tool form and 80 curl atoms went to bash because there was nowhere else to go.
 */
export const curlHealthProbe: SubstitutionPair = {
  id: 'service.curl-health-probe',
  intentLabel: 'local-service-health-probe',
  bashPattern: /^curl\b[^\n]*https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/(?:api\/)?(?:health|version)\b/,
  toolName: 'dev:service_health',
  advisoryText:
    'dev:service_health probes a FIXED set (operator :3070, vite :3055, scout :3350, embed-sidecar :3384) and returns its own diagnostic shape — it takes no url/port argument and never returns the /api/health body. For :3170 staging, :8788 gateway, or any health payload you actually read, keep using curl.',
  routing: {
    want: 'whether a local dev service is answering',
    use: '`dev:service_health` — for the probed set, when you need only up/down',
    insteadOf: '`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :3170/:8788/etc, and whenever you read the body',
  },
  expectedVerdict: 'needs-widening',
  cover(atom: string): CoverageResult {
    const target = curlTarget(atom);
    if (!target) {
      return { covered: false, reason: 'no resolvable loopback URL; dev:service_health takes no url argument' };
    }
    const probed = PROBED_PORTS[target.port];
    if (!probed) {
      return {
        covered: false,
        reason: `probes :${target.port}, which dev:service_health does not probe — it has no port/url argument to add one`,
      };
    }
    if (!DISCARDS_BODY.test(atom)) {
      return {
        covered: false,
        reason: `reads the ${target.path} response BODY; dev:service_health returns its own diagnostic payload, never that body`,
      };
    }
    return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probed}').up` };
  },
};

/**
 * P-009 — "what is listening / who owns this port?" → `dev:service_health`.
 *
 * The plan predicted this one: `dev:service_health` returns no sockets. Its
 * `ProbeResult.url` is the address it TRIED, not evidence anything is bound
 * there, and there is no pid/owner anywhere in the payload.
 *
 * The `PROBED_PORTS` branch below is the genuine overlap and is kept as a
 * TRIPWIRE: a port-scoped query for a probed port, asking only whether a
 * listener exists (no process-ownership flag), IS faithfully answered by that
 * port's probe. If P-013 later adds a socket table and this pair is re-derived,
 * that branch is where the coverage will start appearing.
 *
 * `^ss(?:\s|$)` rather than `^ss\b`: the corpus contains JavaScript heredocs
 * with `ss._blocked = true` and `ss = makeStore()`, which `\b` happily matched.
 * The harness surfaced them as "atoms" the first time this pattern ran — a
 * pattern that claims a language's variable names is not claiming an intent.
 */
export const listeningPorts: SubstitutionPair = {
  id: 'service.listening-ports',
  intentLabel: 'listening-socket-query',
  bashPattern: /^(?:ss|netstat)(?:\s|$)|^lsof\b[^\n]*\s-{1,2}i/,
  toolName: 'dev:service_health',
  advisoryText:
    'dev:service_health returns no listening sockets and no owning pid — its per-service `url` is the address it probed, not proof of a bound listener. There is no tool form for ss/lsof/netstat today (P-013 tracks adding one); keep using them.',
  routing: {
    want: 'what is listening on a port / which process owns it',
    use: '`dev:service_health` — REJECTED for this intent (see P-009); it returns no sockets and no pids',
    insteadOf: '`ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` — no tool form; keep using bash',
  },
  expectedVerdict: 'not-a-substitute',
  cover(atom: string): CoverageResult {
    // `-p` anywhere in an `ss` flag CLUSTER (`-ltnp`, `-lptn`, `-tinp`) asks for
    // the owning process; `lsof` always prints COMMAND/PID, so it always does.
    // Case-sensitive on purpose: lsof's `-P` means "numeric ports", not process.
    const wantsOwner = /(?:^|\s)-[a-zA-Z]*p[a-zA-Z]*\b/.test(atom) || /^lsof\b/.test(atom);
    const portMatch = /(?:iTCP:|:)(\d{2,5})\b/.exec(atom);
    const port = portMatch?.[1];
    if (wantsOwner) {
      return {
        covered: false,
        reason: 'asks which PROCESS owns the socket; dev:service_health returns no pid or command for any service',
      };
    }
    if (!port) {
      return {
        covered: false,
        reason: 'asks for the socket table itself; dev:service_health returns per-service probe results, never a socket list',
      };
    }
    const probed = PROBED_PORTS[port];
    if (!probed) {
      return {
        covered: false,
        reason: `asks about :${port}, which dev:service_health does not probe — and it returns no socket table to look it up in`,
      };
    }
    // Genuine overlap: "is anything listening on a port we probe" is answered by
    // that probe succeeding. See the tripwire note above.
    return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probed}').up` };
  },
};

/**
 * The lifecycle-WRITE finding, recorded as data because it earned no pair.
 *
 * `systemctl restart|start|stop` is 41 atoms / 11 distinct shapes / 9 sessions —
 * below `MIN_SAMPLE_SIZE`, so no verdict may be issued. What the shapes say is
 * more interesting than a verdict would have been:
 *
 *   • ZERO raw restarts of `papercup-dev-api` or `papercup-staging-api` in seven
 *     days, against 34 `is-active`/`status` reads of staging-api alone. Those are
 *     precisely the two units `CLAUDE.md` names in its "never shell out to a raw
 *     `systemctl --user restart`" rule, and the rule appears to have worked:
 *     the restart intent moved to `dev:restart` while the READ intent, which no
 *     rule mentions and no tool serves, stayed in bash. That is the P-019 thesis
 *     (prose that cannot drift from the gate) showing up in the corpus.
 *   • Of the 32 `restart` atoms, 28 target `papercup-oddsmith-sidecar` — not a
 *     `dev:restart` target — and 4 target `papercup-bg-host`, which is. So even
 *     the residue is mostly a unit the tool cannot name.
 *   • 9 of the 11 distinct shapes are `start`/`stop`, which `dev:restart` cannot
 *     express at all: its handler only ever runs `systemctl --user restart`.
 */
export const SERVICE_LIFECYCLE_WRITE_FINDING = {
  pattern: /^systemctl\s+(?:--\S+\s+)*(?:restart|start|stop)\b/,
  atoms: 41,
  distinctShapes: 11,
  sessions: 9,
  verdictWithheld: 'sample below MIN_SAMPLE_SIZE (20 distinct) — no verdict may be issued',
  note: 'restart intent already migrated to dev:restart; residue is oddsmith-sidecar (not a target) and start/stop (not expressible).',
} as const;

/** Every pair in the service family, in registry order. */
export const SERVICE_PAIRS: SubstitutionPair[] = [systemctlIsActive, curlHealthProbe, listeningPorts];
