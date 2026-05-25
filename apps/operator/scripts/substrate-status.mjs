#!/usr/bin/env node
/**
 * substrate-status — one-screen substrate diagnostic CLI.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Hits the operator's substrate JSON endpoints + prints a compact
 * status report. Same data as /admin/dogfood-substrate but in a
 * terminal-friendly form so monitoring scripts, CI, and `+` console
 * launches can surface the substrate state without a browser.
 *
 * Reads:
 *   - PAPERCUSP_API_BASE (default http://127.0.0.1:3070)
 *
 * Exit codes:
 *   0  flag off OR every harness healthy
 *   1  any harness is degraded / unhealthy / booting
 *   2  fetch failed entirely (operator unreachable)
 *
 * Best-effort: every fetch failure becomes a degraded line + exits 2.
 */

const baseUrl = (process.env.PAPERCUSP_API_BASE ?? 'http://127.0.0.1:3070').replace(
  /\/$/,
  '',
);

async function get(path) {
  try {
    const res = await fetch(baseUrl + path, { cache: 'no-store' });
    if (!res.ok) return { err: `HTTP ${res.status}` };
    return { ok: await res.json() };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

function pad(s, n) {
  return String(s ?? '').padEnd(n);
}

async function main() {
  const status = await get('/api/admin/dogfood-substrate-status');
  if (status.err) {
    console.error(`✗ substrate-status fetch failed: ${status.err}`);
    process.exit(2);
  }
  const { enabled, booted = [], bootedCount = 0 } = status.ok ?? {};
  console.log(
    `Substrate flag: ${enabled ? '✓ ON' : '· off'}   booted: ${bootedCount} harness${
      bootedCount === 1 ? '' : 'es'
    }`,
  );
  if (!enabled) {
    console.log(
      '  → set PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1 and restart to engage.',
    );
    process.exit(0);
  }
  if (booted.length === 0) {
    console.log('  → flag is on but no handles in boot map yet.');
    process.exit(1);
  }

  const health = await get('/api/admin/dogfood-substrate-health');
  if (health.err) {
    console.error(`✗ substrate-health fetch failed: ${health.err}`);
    process.exit(2);
  }
  const { harnesses = [], summary } = health.ok ?? {};
  if (summary && typeof summary === 'object') {
    const segs = [];
    if (summary.healthy) segs.push(`${summary.healthy}✓`);
    if (summary.booting) segs.push(`${summary.booting}⏳`);
    if (summary.degraded) segs.push(`${summary.degraded}!`);
    if (summary.unhealthy) segs.push(`${summary.unhealthy}✗`);
    if (summary.disabled) segs.push(`${summary.disabled}·`);
    const seg = segs.length > 0 ? segs.join(' ') : '—';
    console.log(
      `Workspace summary: ${summary.worstVerdict ?? '?'}   ${seg}`,
    );
  }
  console.log('');
  console.log(`  ${pad('workspace', 24)} ${pad('harness', 24)} verdict`);
  let anyBad = false;
  for (const h of harnesses) {
    const verdict = h.verdict ?? 'unknown';
    if (
      verdict === 'degraded' ||
      verdict === 'unhealthy' ||
      verdict === 'booting'
    ) {
      anyBad = true;
    }
    const mark =
      verdict === 'healthy'
        ? '✓'
        : verdict === 'disabled'
          ? '·'
          : verdict === 'booting'
            ? '⏳'
            : verdict === 'degraded'
              ? '!'
              : verdict === 'unhealthy'
                ? '✗'
                : '?';
    console.log(
      `  ${pad(h.workspaceId, 24)} ${pad(h.harnessSlug, 24)} ${mark} ${verdict}`,
    );
    if (
      h.reasons &&
      Array.isArray(h.reasons) &&
      h.reasons.length > 0 &&
      verdict !== 'healthy'
    ) {
      for (const r of h.reasons) {
        console.log(`      · ${r}`);
      }
    }
  }
  process.exit(anyBad ? 1 : 0);
}

main().catch((e) => {
  console.error('substrate-status: unexpected error:', e);
  process.exit(2);
});
