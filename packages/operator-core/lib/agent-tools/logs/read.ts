/**
 * logs:read — the matching lines from a systemd unit's journal, distilled.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-023 (D-027 measurement + design
 * ruling). The parsing, argv construction and journalctl error semantics live in
 * `lib/journal-read.ts` so they are testable without a real journal; this file is
 * the argument envelope and the honest-null projection.
 *
 * ── Why a new verb and not a mode on something existing (D-027 §1) ──────────
 * `dev:service_health` answers up/down/latency for a FIXED endpoint registry —
 * a different question, and it feeds an alarm path. The existing `journal:*`
 * group is the AGENT journal (peer briefs, push utilization): reusing that
 * namespace would collide on the single most confusable word in the system.
 * Before building, `tools:find` for a unit-journal reader was run and returned
 * exactly those two plus `activity:tool-log` — reproducing the two saved recipes
 * (`locate-checkpoint-journal-reader`, `find-bounded-log-inspection-tool`) in
 * which agents searched for this tool, found nothing, and fell back to raw
 * journalctl. There is no surface to extend; this is the missing one.
 *
 * ── Why there is no raw-output passthrough ──────────────────────────────────
 * 96% of the measured corpus pipes journalctl into `| grep` / `| tail`, and 0%
 * uses `--grep`. Handing back raw output would re-create that pipe inside the
 * tool and forfeit the whole saving. `grep` is pushed down to journalctl.
 *
 * ── Scope, stated honestly so the substitution pair cannot lie ──────────────
 * `-f`/`--follow` (4 of 428 measured commands) is NOT covered: a streaming
 * follow has no request/response form, the same caveat `capability:read` carries
 * for `tail -f`. Keep using bash for that.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveUnitName } from '../dev/systemd-service-probe';
import {
  JOURNAL_LEVELS,
  JOURNAL_READ_DEFAULT_LIMIT,
  JOURNAL_READ_DEFAULT_SINCE,
  JOURNAL_READ_MAX_LIMIT,
  JOURNAL_SCOPES,
  readJournal,
} from '../../journal-read';

export default defineTool({
  name: 'logs:read',
  profile: 'engineer',
  description:
    "A systemd unit's journal lines, filtered SERVER-SIDE and distilled — the `journalctl --user -u <unit> --since <w> | grep <pat> | tail -n` answer as { entries:[{ts,unit,level,message,repeat}], matched, collapsed, truncated }. `grep` is pushed down to `journalctl --grep` so only matching lines are ever read, and consecutive identical lines collapse to one row + a count. Reads the journal only — it does not follow (`-f`) and does not restart anything.",
  capability: 'intel:read',
  guidance: {
    when: 'You need what a service actually logged: diagnosing why a unit failed, restarted, or went quiet; finding a specific marker line in a window; confirming a deploy/tick/job ran. Pass `grep` with the needle you would have piped to grep — that is the point of the tool.',
    notWhen: 'NOT "is the service up" (dev:service_health) and NOT "did MY background job finish" (capability:bash_output). A live streaming follow (`journalctl -f`) has no tool form — keep using bash for that. Reading a *.log FILE is capability:read.',
    chaining: 'dev:service_health says a unit is down → logs:read { unit, grep:"error|failed" } says why. Widen by loosening `grep` or `since`, not by dropping to raw journalctl.',
    returns:
      "{ entries[], matched, collapsed, truncated, window, units, unitsUnknown, journalAvailable, journalError, command }.\n\nAN EMPTY `entries` HAS FOUR DIFFERENT MEANINGS — read these fields before concluding anything from it:\n  • unitsUnknown non-empty → systemd does not know that unit. The name is WRONG (a typo, or it was never installed); journalctl exits 0 with no lines for a unit that never existed, so this is NOT a quiet service. Fix the name and re-read.\n  • journalError non-null → the read FAILED (including a scan that TIMED OUT before finishing — a wide `since` + a `grep` + the `-n` tail cap forces a slow reverse scan on a chatty unit). `entries` is meaningless, NOT empty, and `matched` is `null`, NEVER 0 — a 0 there would be indistinguishable from a genuinely clean window. Never report 'no errors in the log' from this state; on a timeout, narrow `since`/`grep` or lower `limit` and retry.\n  • journalAvailable:false → this host has NO systemd journal at all (macOS, a container, the shipped desktop target). Says nothing about the service.\n  • all three clear → the window is GENUINELY CLEAN. (journalctl exits 1 when --grep matches nothing; that is a clean read, not a failure.)\n\n`repeat` > 1 means that row stands for N CONSECUTIVE identical lines (`lastTs` is the final one); `collapsed` totals the lines removed. `truncated:true` means older rows were dropped to honour `limit` — the NEWEST are kept, so widen `since` or tighten `grep` rather than raising `limit` blindly. `matched` counts lines before dedup but is BOUNDED BY limit+1 (the cap is pushed down to journalctl's `-n`), so on a truncated read it is a FLOOR, never the true total — do not report it as 'there were N matches'. `command` is the exact journalctl argv, so any result is reproducible by hand.",
    seeAlso: [
      'dev:service_health (is a KNOWN service healthy — probes the endpoint registry)',
      'dev:restart (restart a dev service, with the drain protocol)',
      'capability:read (read a *.log FILE, including `tail -n` semantics)',
    ],
  },
  requirePrincipal: false,
  // journal-read shells out to journalctl/systemctl and never reads ctx.tx. Do not
  // retain the dispatcher's ambient org-app transaction while that host I/O runs;
  // code:run's inner dispatch honors this flag too, avoiding a pool acquisition
  // before log triage under fleet load (EI-20246577252417163).
  skipWorkspaceTx: true,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    unit: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(10)])
      .optional()
      .describe("Unit name(s). A bare name is `.service`-suffixed ('papercup-bg-host' → 'papercup-bg-host.service'); '.timer'/'.socket'/'.target' etc are left alone. Several units read as one merged, time-ordered stream."),
    identifier: z.string().min(1).max(200).optional()
      .describe('Syslog identifier (`journalctl -t`), for entries logged without a unit.'),
    since: z.string().min(1).max(100).optional()
      .describe(`Window start, in journalctl's own grammar: '-30 min', '2 hours ago', '09:40:00', '2026-07-26 00:00'; compact lookbacks such as '40m' and '-2h' are also accepted. Default '${JOURNAL_READ_DEFAULT_SINCE}'. REQUIRED when neither unit nor identifier is given, because an unscoped scan walks every unit in the journal (measured 25.97s versus 7.58s scoped, on the same host).`),
    until: z.string().min(1).max(100).optional().describe('Window end, same grammar. Omit for "up to now".'),
    grep: z.string().min(1).max(500).optional()
      .describe('Case-insensitive PCRE pushed down to `journalctl --grep`, so non-matching lines are never read. Pass the needle you would otherwise have piped to grep — alternation works: "oom|killed process".'),
    level: z.enum(JOURNAL_LEVELS).optional()
      .describe("Minimum severity: this level AND MORE SEVERE (journalctl `-p` semantics), so level:'err' also returns crit/alert/emerg."),
    limit: z.number().int().min(1).max(JOURNAL_READ_MAX_LIMIT).optional()
      .describe(`Max rows returned, newest kept (default ${JOURNAL_READ_DEFAULT_LIMIT}). Collapsed repeats count as ONE row.`),
    scope: z.enum(JOURNAL_SCOPES).optional()
      .describe("Which journal: 'user' (default, the papercup-* units), 'system' (kernel/OOM records, pgbouncer, systemd-oomd — a DIFFERENT journal, not a filter), or 'all' (everything you can see). If a unit you know exists comes back with unitsUnknown naming it, you are reading the wrong journal."),
  }),
  async handler(args, ctx) {
    void ctx;
    const units = args.unit === undefined
      ? []
      : (Array.isArray(args.unit) ? args.unit : [args.unit]).map(resolveUnitName);

    // An unscoped read walks EVERY unit in the journal. That is a real cost
    // (25.97s vs 7.58s on a 1.2GB journal, per soak-report's measurement), so it
    // stays available — 35 of 428 measured commands genuinely need it — but only
    // with an explicit window, never with a silently-defaulted one.
    if (!units.length && !args.identifier && !args.since) {
      return {
        data: {
          ok: false,
          error: 'unscoped_read_needs_since',
          detail:
            'Reading with no `unit` and no `identifier` scans every unit in the journal. Pass `unit` (much faster), or pass an explicit `since` window to accept the host-wide scan.',
        },
      };
    }

    const result = await readJournal({
      units,
      identifier: args.identifier,
      since: args.since,
      until: args.until,
      grep: args.grep,
      level: args.level,
      limit: args.limit,
      scope: args.scope,
    });

    return { data: { ok: result.journalError === null, ...result } };
  },
});
