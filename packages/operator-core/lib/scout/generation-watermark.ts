/**
 * generation-watermark.ts — named GENERATION watermarks for evidence windows
 * (rubric-system-hardening-2026-07-14 P-002, EI-12148).
 *
 * The motivating defect: the scout bg-host is a LONG-LIVED process, so "the fix is
 * deployed on disk" and "the fix is what's running" diverge until the host restarts —
 * and the release instrument (blender:success-metrics) judged a fixed system FAIL for
 * up to 48h on errors the PRE-fix generation emitted (9.0% reported while the true
 * post-restart rate was 0/8, 2026-07-14). The host's ActiveEnterTimestamp IS the
 * generation boundary: everything at/after it was produced by the code currently
 * running. This module resolves that boundary as a named watermark
 * ({@link BG_HOST_RESTART_WATERMARK}) so instruments can judge "the running
 * generation" instead of a fixed look-back that straddles a restart.
 *
 * Split like every scout instrument: a PURE parser ({@link parseSystemdTimestamp},
 * unit-tested) + a thin IO edge ({@link readBgHostActiveEnterMs}, one systemctl exec).
 * Resolution DEGRADES to null (host not running / no systemd / non-Linux) — the caller
 * decides whether that is a loud error (an explicitly requested watermark, the
 * blender:success-metrics arg) or a provenance-tagged fallback (a rubric-declared
 * window, resolveCriterionWindow's 'watermark-unresolved').
 */
import { execFile } from 'node:child_process';

/** The named watermark: the running scout bg-host generation's start instant. */
export const BG_HOST_RESTART_WATERMARK = 'bg-host-restart';

/** The systemd user unit hosting the scout loop (the long-lived generation). */
export const BG_HOST_UNIT = 'papercup-bg-host.service';

/** Watermark refs this module can resolve (the vocabulary the tool arg documents). */
export const KNOWN_WATERMARK_REFS: readonly string[] = [BG_HOST_RESTART_WATERMARK];

/**
 * PURE: parse a systemd `show -p <TimestampProp> --value` string → epoch-ms.
 * Read with TZ=UTC the value is `Tue 2026-07-14 18:08:24 UTC`; an inactive/never-started
 * unit yields `` or `n/a`. Returns null on anything unparseable — never throws.
 */
export function parseSystemdTimestamp(value: string | null | undefined): number | null {
  const v = (value ?? '').trim();
  if (!v || v === 'n/a') return null;
  // Canonical: [Dow ]YYYY-MM-DD HH:MM:SS ZONE. Parse the date+time explicitly and trust
  // the zone token only when it is UTC (we exec with TZ=UTC, so this is the normal path);
  // otherwise fall back to Date.parse of the raw string (V8 handles US zone abbrevs).
  const m = v.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s+(\S+))?/);
  if (m) {
    const [, date, time, zone] = m;
    if (!zone || zone === 'UTC' || zone === 'GMT' || zone === 'Z') {
      const ms = Date.parse(`${date}T${time}Z`);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * IO edge: the running bg-host generation's start instant (epoch-ms), or null when it
 * cannot be determined (unit not running, no systemd user session, non-Linux, timeout).
 * One short-lived `systemctl --user show` exec with TZ=UTC so the timestamp parses
 * deterministically regardless of the host's local zone.
 */
export function readBgHostActiveEnterMs(unit: string = BG_HOST_UNIT): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ActiveEnterTimestamp', '--value'],
      { env: { ...process.env, TZ: 'UTC' }, timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseSystemdTimestamp(stdout));
      },
    );
  });
}

export type WatermarkResolution = { ok: true; ms: number } | { ok: false; error: string };

/**
 * Resolve a named watermark ref → epoch-ms, with a TEACHING error for the two distinct
 * failure shapes: an UNKNOWN ref (caller typo / not in the vocabulary) vs a known ref
 * that is currently UNRESOLVABLE (the generation boundary genuinely can't be read —
 * judging "post-watermark" would be judging an unknown window, so the caller must not
 * silently substitute one).
 */
export async function resolveWatermarkRef(ref: string): Promise<WatermarkResolution> {
  if (ref !== BG_HOST_RESTART_WATERMARK) {
    return {
      ok: false,
      error: `unknown watermarkRef '${ref}' — known refs: ${KNOWN_WATERMARK_REFS.join(', ')}`,
    };
  }
  const ms = await readBgHostActiveEnterMs();
  if (ms === null) {
    return {
      ok: false,
      error:
        `watermark '${ref}' did not resolve: ${BG_HOST_UNIT} is not running under systemd --user ` +
        '(or its ActiveEnterTimestamp is unreadable). Pass an explicit sinceMs, or omit both for the default window.',
    };
  }
  return { ok: true, ms };
}
