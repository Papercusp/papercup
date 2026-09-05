#!/usr/bin/env bash
# P-005 clause 4 acceptance: prove the ENFORCING CSP is live and does not break the app.
#
# HOW TO RUN (no arguments, no setup — the harness supplies everything):
#
#   scripts/verify-tauri-headless.sh -- scripts/verify-csp-enforcing.sh
#
# verify-tauri-headless.sh boots papercusp-desktop on its OWN auto-picked Xvfb
# display and devUrl port, exports VERIFY_TAURI_PID / VERIFY_TAURI_DEV_URL, runs
# this script, and tears the whole tree down afterwards. Nothing here is pinned to
# a particular display, port, or time window, so any agent can re-execute it and
# get a verdict comparable to the one recorded on the scorecard.
#
# Report-only mode could only ever show "nothing WOULD have been blocked". This run
# adds the evidence that phase could not produce: under real enforcement, a foreign
# fetch is actually BLOCKED, so a route that still renders its DOM is proof the
# policy does not break the shell.
#
# Per route: navigate -> re-install the violation listener ON THE NEW DOCUMENT ->
# prove it live with controls -> only then record a verdict. A zero from an
# unproven probe is indistinguishable from a dead probe (learned the hard way:
# the listener lives on `window`, and each navigation makes a NEW document, so a
# listener installed once reports a vacuous [] for every later route).
set -uo pipefail

: "${VERIFY_TAURI_PID:?run me through scripts/verify-tauri-headless.sh -- scripts/verify-csp-enforcing.sh}"
: "${VERIFY_TAURI_DEV_URL:?run me through scripts/verify-tauri-headless.sh -- scripts/verify-csp-enforcing.sh}"

TAT=(tauri-agent-tools eval --pid "$VERIFY_TAURI_PID")

echo "##### 1. HEADER CHECK — is the enforcing header actually on the document response?"
HDRS="$(curl -sI "$VERIFY_TAURI_DEV_URL/" || true)"
ENF="$(printf '%s' "$HDRS" | grep -ci '^content-security-policy:' || true)"
RPT="$(printf '%s' "$HDRS" | grep -ci '^content-security-policy-report-only:' || true)"
echo "enforcing_header_present=$ENF  report_only_header_present=$RPT"
printf '%s' "$HDRS" | grep -i '^content-security-policy' | cut -c1-160
if [ "$ENF" != "1" ] || [ "$RPT" != "0" ]; then
  echo "HEADER_VERDICT=FAIL (want enforcing=1 report_only=0)"
else
  echo "HEADER_VERDICT=PASS"
fi
echo

echo "##### 2. PER-ROUTE SWEEP UNDER ENFORCEMENT"
ROUTES=(
  "/?ws=papercusp-workspace"
  "/editor-demo?ws=papercusp-workspace"
  "/notes?ws=papercusp-workspace"
  "/design?ws=papercusp-workspace"
  "/cupboard?ws=papercusp-workspace"
  "/adv?tab=harnesses&ws=papercusp-workspace"
  "/settings/voice?ws=papercusp-workspace"
  "/admin/git?ws=papercusp-workspace"
)

for R in "${ROUTES[@]}"; do
  # Navigate, then install a FRESH listener on the resulting document.
  "${TAT[@]}" "location.href = '${VERIFY_TAURI_DEV_URL}${R}'; 'nav'" >/dev/null 2>&1
  sleep 4

  "${TAT[@]}" "
    (() => {
      window.__csp = { v: [], controls: 0 };
      addEventListener('securitypolicyviolation', (e) => {
        const uri = String(e.blockedURI || '');
        if (uri.includes('.invalid')) { window.__csp.controls++; return; }
        window.__csp.v.push({ directive: e.violatedDirective, blocked: uri.slice(0, 120) });
      });
      // POSITIVE CONTROL: three reserved-TLD fetches that must trip the policy.
      // Nothing leaves the box (.invalid is reserved and unresolvable).
      for (let i = 0; i < 3; i++) { const im = new Image(); im.src = 'https://csp-control-' + i + '.invalid/x.png'; }
      return 'armed';
    })()
  " >/dev/null 2>&1
  sleep 2

  "${TAT[@]}" "
    (() => {
      const p = window.__csp || { v: [], controls: 0 };
      const origins = [...new Set(performance.getEntriesByType('resource')
        .map(e => { try { return new URL(e.name).origin; } catch { return 'opaque'; } }))];
      const foreign = origins.filter(o =>
        !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o) &&
        !o.startsWith('papercusp:') && o !== 'opaque' && o !== location.origin);
      // Did the app actually RENDER? Under enforcement a blocked script would
      // leave an empty shell, so this is the load-bearing new signal.
      const root = document.querySelector('#root, #app, body');
      const rendered = !!root && root.textContent.trim().length > 40 &&
        document.querySelectorAll('*').length > 60;
      return JSON.stringify({
        path: '${R}',
        resources: performance.getEntriesByType('resource').length,
        elements: document.querySelectorAll('*').length,
        controlSeen: p.controls,
        rendered,
        foreignOrigins: foreign,
        realViolations: p.v,
        VERDICT: (p.controls > 0 && rendered && foreign.length === 0 && p.v.length === 0)
          ? 'CLEAN + RENDERED (probe proven live)'
          : (p.controls === 0 ? 'INVALID — probe never fired, verdict meaningless' : 'INVESTIGATE')
      });
    })()
  " 2>&1 | tr -d '\n' | sed 's/  */ /g'
  echo
done
echo "##### SWEEP COMPLETE"
