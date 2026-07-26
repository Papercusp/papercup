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
 *   • `supervision[]` — one row per `SUPERVISED_PROCESSES` entry, carrying
 *     `flapState` / `restartsLast10m` / `consecutiveProbeFailures` /
 *     `secondsSinceStart` — restart CHURN — PLUS, for `systemd-user` rows, an
 *     `active?: boolean` derived from systemd `ActiveState`: `false` means
 *     confirmed DOWN, OMITTED means the probe genuinely could not tell. A
 *     missing `active` must never be read as "down".
 *
 * ⚠ HISTORY, because the original verdict rests on it: this block used to carry
 * NO up-or-down field at all, and a stopped unit was indistinguishable from a
 * failed probe (both left `secondsSinceStart` undefined). That was D-010 item 2
 * and it has been FIXED — `active` is added by the tool's overlay
 * (`SupervisionStatusEntryWithRecency`), NOT by `unit-reconciler`'s own type,
 * which is why grepping the reconciler still makes it look like an open gap.
 *
 * The practical consequence TODAY: `papercup-dev-api` (→ `operator`),
 * `papercup-staging-api` (→ `staging-api`, added by WI-6146), `papercup-bg-host`
 * (→ `bg-host-ticker`) and `papercup-embed-sidecar` (→ `embed-sidecar`) have a
 * liveness answer from a PROBE. `papercup-inference-gateway`,
 * `papercup-mcp-proxy` and `papercup-live-federation-gate` remain supervised but
 * unprobed — they now get a determinate `active` from systemd, but no HTTP
 * probe, so nothing confirms they are actually SERVING.
 *
 * ⚠ MODEL DRIFT: the constants below are a hand-written MODEL of that tool, and
 * nothing in the equivalence machinery reads the real `HEALTH_ENDPOINTS`. The
 * `expectedVerdict` latch does NOT catch a tool that was widened without
 * updating this model — it only catches a model changed without updating the
 * verdict. `pairs/service-model-drift.test.ts` (WI-6153) is the guard that
 * closes that hole; keep it green rather than routing around it.
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
export const PROBED_PORTS: Record<string, string> = {
  '3070': 'operator',
  '3055': 'vite',
  '3350': 'scout',
  '3384': 'embed-sidecar',
  // WI-6146 added this to HEALTH_ENDPOINTS; the model must follow or the audit
  // scores against a tool that no longer exists. `service-model-drift.test.ts`
  // is what forces that now — see the note on MODEL DRIFT below.
  '3170': 'staging-api',
  // WI-6149 (D-010 item 4): the oddsmith sidecar's Hono port, pinned in its unit
  // file as `ODDSMITH_HONO_PORT=46229`. Named in `curlHealthProbe`'s header as
  // one of the unprobed ports the corpus curls — now probed.
  '46229': 'oddsmith-sidecar',
};

/**
 * systemd units whose liveness `dev:service_health` can actually answer, and the
 * `services[]` probe that answers it. Note NONE of these is answered by the
 * `supervision[]` block — they are answered because something probes them.
 */
export const UNIT_TO_PROBE: Record<string, string> = {
  'papercup-dev-api': 'operator',
  'papercup-bg-host': 'bg-host-ticker',
  'papercup-embed-sidecar': 'embed-sidecar',
  // WI-6146: staging-api is now genuinely probed (:3170), so `is-active
  // papercup-staging-api` HAS a faithful tool expression. It moved out of
  // SUPERVISED_BUT_UNPROBED below.
  'papercup-staging-api': 'staging-api',
  // WI-6149 (D-010 item 4): the single most-asked-about unit in this pair's
  // corpus that had no answer at all (73 `is-active` atoms). Now probed on
  // :46229 with 2-tick flap damping — see `ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS`.
  'papercup-oddsmith-sidecar': 'oddsmith-sidecar',
};

/**
 * Units that ARE in `SUPERVISED_PROCESSES` but have no HTTP probe.
 *
 * ⚠ WI-6149 RECLASSIFIED these as COVERED for THIS pair, and the reason matters
 * because it moves the score. The old `cover()` reason claimed the tool "returns
 * a supervision row with flap counters and no up/down field" — that sentence was
 * already false when it was written: this file's own header records that
 * `active` had been added by the tool overlay (D-010 item 2, WI-6146). The model
 * carried a stale failure reason and scored against it, which is the same defect
 * class as the false "there is no tool form" advisory item 3 removed from
 * `listeningPorts`.
 *
 * The test that settles it is the pair's own scoping rule: does the tool answer
 * THE QUESTION THE ATOM ASKED? `systemctl is-active <unit>` asks systemd for
 * `ActiveState`; `supervision[].activeState` returns that same string verbatim
 * for every registered systemd-user unit, plus `healthy` (the same oracle the
 * reconciler acts on). That is a faithful, complete answer. "Nothing confirms it
 * is actually SERVING" is a DIFFERENT question — `curlHealthProbe` owns it — and
 * folding it in here would enforce an advisory against a question the agent did
 * not ask, which is exactly the reasoning this file uses to exclude `systemctl
 * status`. Consistency has to cut both ways.
 *
 * The set is KEPT (not deleted) because it is still the right distinction for the
 * serving question, and because the remedy for these differs from an unregistered
 * unit's: they need a PROBE, not registration.
 */
export const SUPERVISED_BUT_UNPROBED = new Set([
  // NOTE: `papercup-staging-api` used to head this list. WI-6146 gave it a real
  // probe (:3170), so it now lives in UNIT_TO_PROBE instead. Its removal is the
  // single largest coverage change this family has seen — staging-api was the
  // most-asked-about unit in the corpus (34 is-active/status reads in 7d).
  'papercup-inference-gateway',
  'papercup-mcp-proxy',
  'papercup-live-federation-gate',
  'papercup-live-federation-gate.timer',
]);

/**
 * WI-6149: the `supervision[].name` each unprobed-but-registered UNIT reports as.
 * Needed so `cover()`'s `expression` names the field an agent would actually read
 * — `supervision[]` is keyed by the registry's `name`, not by the systemd unit, and
 * emitting the unit there would be a wrong expression on a correct `covered` (the
 * quieter half of the D-001 failure mode, per `listeningPorts`' item-3 fix).
 * `service-model-drift.test.ts` asserts this covers SUPERVISED_BUT_UNPROBED exactly
 * and that every value is a real registry row name.
 */
export const SUPERVISION_ROW_NAME: Readonly<Record<string, string>> = {
  'papercup-inference-gateway': 'inference-gateway',
  'papercup-mcp-proxy': 'mcp-proxy',
  'papercup-live-federation-gate': 'live-federation-gate',
  'papercup-live-federation-gate.timer': 'live-federation-gate-timer',
};

function supervisionNameFor(unit: string): string {
  return SUPERVISION_ROW_NAME[unit] ?? unit;
}

/**
 * WI-6149: units named by an atom BEYOND the first — `systemctl` accepts a unit
 * LIST (`is-active fail2ban crowdsec`) and `systemctlUnit` only ever returns the
 * head. Returns the tail (empty for the normal single-unit shape). Applies the
 * same token filter as `systemctlUnit`, so redirects/flags/globs never count as
 * units; a `$(…)`/glob token stops the scan rather than being reported as a unit
 * name, matching `systemctlUnit`'s own refusal to resolve one.
 */
export function additionalUnits(atom: string): string[] {
  const match = /^systemctl\s+((?:--?\S+\s+)*)(\S+)\s*(.*)$/.exec(atom);
  if (!match) return [];
  const units: string[] = [];
  for (const token of match[3].trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('-')) continue;
    if (/^[$|>&]/.test(token) || /^\d?>/.test(token)) continue;
    if (token.includes('*')) break;
    units.push(normalizeUnit(token));
  }
  return units.slice(1);
}

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
    'dev:service_health answers is-active for EVERY unit in the supervision registry, two ways. Probed (up/down + latency): papercup-dev-api :3070, papercup-staging-api :3170, papercup-bg-host, papercup-embed-sidecar :3384, papercup-oddsmith-sidecar :46229, plus vite :3055 / scout :3350. Registered but unprobed (papercup-inference-gateway, papercup-mcp-proxy, papercup-live-federation-gate + its .timer): supervision[] carries systemd ActiveState verbatim as `activeState` plus `healthy` — read `healthy`, since an `episodic` timer-driven unit like the federation gate is idle, not down, while inactive. OMITTED means the probe could not tell; never read that as down. Keep using systemctl for a unit OUTSIDE the registry (papercusp-db-backup, a green-checkpoint-manual-* run, auditd/pgbouncer at system scope) — service-health.ts NON_PROBED_UNITS records why each is excluded.',
  routing: {
    want: 'whether a systemd unit is currently active',
    use: '`dev:service_health` — services[].up for the probed set (operator/staging-api/vite/scout/embed-sidecar/oddsmith-sidecar/bg-host), supervision[].{activeState,healthy} for every other registered systemd-user unit',
    insteadOf: '`systemctl --user is-active <unit>` — still required for a unit outside the supervision registry (papercusp-db-backup, green-checkpoint-manual-*, system-scope auditd/pgbouncer)',
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
    // WI-6149: MULTI-UNIT in one call (`systemctl is-active fail2ban crowdsec`).
    // `systemctlUnit` returns only the FIRST token, so without this branch the
    // atom is scored — and its failure reason reported — against one of the two
    // units it asked about, silently answering a narrower question than was
    // asked. Same class as `listeningPorts`' multi-port branch, except this one
    // IS observable in the frozen sample.
    const extraUnits = additionalUnits(atom);
    if (extraUnits.length > 0) {
      return {
        covered: false,
        reason: `names ${extraUnits.length + 1} units in one call (${[unit, ...extraUnits].join(', ')}); dev:service_health takes no arguments and returns one fixed registry snapshot`,
      };
    }
    const probe = UNIT_TO_PROBE[unit];
    if (probe) {
      return { covered: true, expression: `dev:service_health → services.find(s => s.name === '${probe}').up` };
    }
    // WI-6149: a registered systemd-user unit IS answered — see the note on
    // SUPERVISED_BUT_UNPROBED for why this counts and what it deliberately does
    // not claim.
    if (SUPERVISED_BUT_UNPROBED.has(unit)) {
      return {
        covered: true,
        expression: `dev:service_health → supervision.find(s => s.name === '${supervisionNameFor(unit)}').{activeState,healthy}`,
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
    'dev:service_health probes a FIXED set (operator :3070, staging-api :3170, vite :3055, scout :3350, embed-sidecar :3384) and returns its own diagnostic shape — it takes no url/port argument and never returns the /api/health body. :3170 IS covered now, so the CLAUDE.md verify-a-staging-edit workflow (dev:restart{target:"staging"} then check staging-api) needs no curl. For :8788 gateway or any other unprobed port, and whenever you actually READ the health payload, keep using curl.',
  routing: {
    want: 'whether a local dev service is answering',
    use: '`dev:service_health` — for the probed set (incl. :3170 staging), when you need only up/down',
    insteadOf: '`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :8788 and other unprobed ports, and whenever you read the body',
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
 * P-009 / P-013 D-017 — "what is listening / who owns this port?" →
 * `dev:listening_ports`.
 *
 * ── RE-DERIVED 2026-07-26 (WI-6149 item 3) ──────────────────────────────────
 * This pair used to point at `dev:service_health` with a `not-a-substitute`
 * verdict and an advisory reading "there is no tool form for ss/lsof/netstat
 * today; keep using them". D-017 built one — `dev:listening_ports` — so that
 * advisory became FALSE, and a false advisory is exactly the staleness shape
 * D-016's drift guards exist to catch. The tripwire the old comment promised
 * ("if P-013 later adds a socket table and this pair is re-derived, that branch
 * is where coverage will start appearing") is now cashed in.
 *
 * MEASURED 15/24 → `needs-widening` (was 0/24 → `not-a-substitute`).
 *
 * The residue is the interesting part, and MEASURING it corrected the guess
 * this comment first carried. All NINE misses are a SINGLE axis — socket STATE:
 *
 *   • 4× all-states ss/netstat (`ss -tn`, `ss -tinp`, `ss -tin dst …`,
 *     `netstat -an -p tcp`) — no `-l`, so the question is about ESTABLISHED
 *     connections, which this tool cannot see.
 *   • 5× lsof without `-sTCP:LISTEN` (`lsof -i :3270`, `-iTCP:8044`, …) — lsof
 *     prints established rows for the port too, so a LISTEN-only reply is a
 *     subset, not a substitute.
 *
 * MULTI-PORT lsof (`-iTCP:3070 -iTCP:19045 -iTCP:3170`) is genuinely
 * inexpressible — `port` is a scalar — but it is NOT independently observable
 * here: both multi-port atoms in the sample ALSO omit `-sTCP:LISTEN`, so the
 * state check rejects them first. The branch is kept and unit-tested directly,
 * because the corpus will eventually contain a `-sTCP:LISTEN` multi-port shape
 * and a verdict that only holds while a second defect masks it is not a
 * verdict. Do not delete it as dead code.
 *
 * Per D-008 the fix for that residue is to NARROW THE PATTERN (splitting the
 * listen-query subset out, as the file-read family did with four patterns) or
 * to WIDEN THE TOOL with a state filter — NOT to lower the bar. Both are real
 * options; neither is done here, because narrowing the pattern requires
 * re-sampling the corpus against the new pattern and this change is already
 * carrying a new verb. `needs-widening` with the failures NAMED is the honest
 * intermediate state, and it is what keeps the pair at tier `observe`.
 *
 * `^ss(?:\s+-|\s*$)` rather than `^ss\b`: the corpus contains JavaScript
 * heredocs with `ss._blocked=true` and `ss=makeStore()`, which `\b` happily
 * matched. The harness surfaced them as "atoms" the first time this pattern ran
 * — a pattern that claims a language's variable names is not claiming an
 * intent. Requiring a FLAG (or nothing at all) after the verb is what separates
 * the two: every one of the 16 distinct real `ss` shapes in the corpus is
 * `ss -<flags>`, while an assignment is always followed by `=`.
 */
export const listeningPorts: SubstitutionPair = {
  id: 'service.listening-ports',
  intentLabel: 'listening-socket-query',
  bashPattern: /^(?:ss|netstat)(?:\s+-|\s*$)|^lsof\b[^\n]*\s-{1,2}i/,
  toolName: 'dev:listening_ports',
  advisoryText:
    'dev:listening_ports { port } answers "what is bound here and which process owns it" — the structured ss/lsof/netstat answer, including a same-uid pid + command. Read ownerVisible before pid: a socket owned by ANOTHER user reports ownerVisible:false, which means bound-but-unreadable, not free. It reports TCP LISTEN only, so keep using bash for established connections and for a single call spanning several ports.',
  routing: {
    want: 'what is listening on a TCP port / which process owns it',
    use: '`dev:listening_ports { port }` (or `{ pid }` for the reverse lookup) — structured rows with pid, command and ownerVisible',
    insteadOf:
      '`ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp`. ⚠ LISTEN sockets only — an established-connection query (`ss -tn`, `netstat -an`) or one lsof call spanning several ports still needs bash',
  },
  expectedVerdict: 'needs-widening',
  cover(atom: string): CoverageResult {
    // ── 1. Is this even a LISTEN query? ──────────────────────────────────────
    // The tool returns TCP sockets in LISTEN state and nothing else, so an
    // all-states query is a DIFFERENT question. Answering it with the listen
    // table is a confident wrong answer, which is the D-001 failure mode.
    //
    // Each verb signals listen-ness differently:
    //   ss / netstat → an `-l` in the flag cluster (`-ltn`, `-lptn`, `-tlnp`).
    //   lsof         → `-sTCP:LISTEN`; without it lsof prints ESTABLISHED rows
    //                  for the port too, and the tool's answer is a subset.
    const isLsof = /^lsof\b/.test(atom);
    const listenOnly = isLsof
      ? /-sTCP:LISTEN\b/.test(atom)
      : /(?:^|\s)-[a-zA-Z]*l[a-zA-Z]*\b/.test(atom);
    if (!listenOnly) {
      return {
        covered: false,
        reason: isLsof
          ? 'no -sTCP:LISTEN, so it also lists ESTABLISHED connections on the port; dev:listening_ports reports LISTEN sockets only'
          : 'no -l flag — this asks for connections in every state; dev:listening_ports reports LISTEN sockets only',
      };
    }

    // ── 2. UDP is out of scope entirely. ─────────────────────────────────────
    if (/(?:^|\s)-[a-zA-Z]*u[a-zA-Z]*\b/.test(atom) || /iUDP/i.test(atom)) {
      return { covered: false, reason: 'asks about UDP; dev:listening_ports reports TCP sockets only' };
    }

    // ── 3. A non-port/pid selector has no argument to carry it. ──────────────
    // `ss -tin dst 140.82.113.3` filters by PEER address; the tool's only
    // filters are `port` and `pid`.
    if (/\b(?:dst|src)\s+\S/.test(atom)) {
      return {
        covered: false,
        reason: 'filters by peer address (dst/src); dev:listening_ports filters only by port or pid',
      };
    }

    // ── 4. Several ports in ONE call. `port` is a scalar. ────────────────────
    // Count SELECTORS, not just literal numbers: `-iTCP:$p` is a port selector
    // whose operand is only known at runtime. Conflating it with "no selector"
    // is what made this branch first emit the whole-table expression for a
    // single-port query — a wrong expression on a correct `covered`, which is
    // the quieter half of the D-001 failure mode.
    const selectors = atom.match(/(?:iTCP:|sport\s*=\s*:)([^\s'"]+)/g) ?? [];
    const operands = [...new Set(selectors.map((t) => t.replace(/^(?:iTCP:|sport\s*=\s*:)/, '')))];
    const literalPorts = operands.filter((o) => /^\d{2,5}$/.test(o));
    if (operands.length > 1) {
      return {
        covered: false,
        reason: `spans ${operands.length} ports (${operands.join(', ')}) in one call; dev:listening_ports takes a single scalar \`port\``,
      };
    }

    // ── 5. Expressible. Name the actual call. ────────────────────────────────
    // A pid selector (`lsof -p "$APPID" -a -iTCP -sTCP:LISTEN`) is the reverse
    // lookup, served by `pid`. A shell-variable operand is still covered: the
    // agent already holds the value it interpolated.
    if (/(?:^|\s)-p\s+\S/.test(atom) && isLsof) {
      return { covered: true, expression: 'dev:listening_ports { pid } → sockets[].port' };
    }
    if (operands.length === 1) {
      const shown = literalPorts.length === 1 ? literalPorts[0] : `<${operands[0]}>`;
      return {
        covered: true,
        expression: `dev:listening_ports { port: ${shown} } → sockets[0].{pid,command,ownerVisible}`,
      };
    }
    return { covered: true, expression: 'dev:listening_ports {} → sockets[] (the whole LISTEN table, one row per port+address+command)' };
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
