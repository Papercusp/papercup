#!/usr/bin/env bash
# Deterministic, read-only Tauri acceptance drive for
# corpus-accurate-counts-and-facets-2026-08-21 P-014.
#
# Run only through scripts/verify-tauri-headless.sh. The wrapper supplies the
# provenance-checked PID and bounded poll helper; this script names every route,
# selector, visible/accessible-copy invariant, capture, and failure exit.
set -euo pipefail

P014_TAURI_TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-}"
P014_TAURI_PID="${VERIFY_TAURI_PID:-}"
P014_TAURI_POLL="${VERIFY_TAURI_POLL:-}"
P014_ACCEPTANCE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
P014_ACCEPTANCE_OUTPUT="${VERIFY_COUNT_SURFACES_OUTPUT:-/tmp/papercusp-p014-tauri-${P014_ACCEPTANCE_STAMP}}"

[ -n "$P014_TAURI_TOOL" ] && [ -x "$P014_TAURI_TOOL" ] || {
  echo "P014_TAURI_FAIL missing executable VERIFY_TAURI_AGENT_TOOLS_BIN" >&2
  exit 64
}
[ -n "$P014_TAURI_PID" ] || {
  echo "P014_TAURI_FAIL missing provenance-checked VERIFY_TAURI_PID" >&2
  exit 64
}
[ -n "$P014_TAURI_POLL" ] && [ -x "$P014_TAURI_POLL" ] || {
  echo "P014_TAURI_FAIL missing executable VERIFY_TAURI_POLL" >&2
  exit 64
}
[ -n "${PAPERCUSP_SID:-}" ] || {
  echo "P014_TAURI_FAIL missing PAPERCUSP_SID provenance" >&2
  exit 64
}

mkdir -p "$P014_ACCEPTANCE_OUTPUT"

p014_navigate() {
  local expression="$1"
  "$P014_TAURI_TOOL" eval --pid "$P014_TAURI_PID" --strict "$expression" >/dev/null
}

p014_assert() {
  local expression="$1"
  "$P014_TAURI_TOOL" check --pid "$P014_TAURI_PID" --strict --eval "$expression"
}

p014_console_clean() {
  "$P014_TAURI_TOOL" check \
    --pid "$P014_TAURI_PID" \
    --strict \
    --no-errors \
    --duration 2500
}

p014_capture() {
  local name="$1"
  local expression="$2"
  "$P014_TAURI_TOOL" capture \
    --pid "$P014_TAURI_PID" \
    --strict \
    --output "$P014_ACCEPTANCE_OUTPUT/$name" \
    --dom-depth 8 \
    --logs-duration 2500 \
    --eval "$expression" \
    --json >"$P014_ACCEPTANCE_OUTPUT/$name-result.json"
}

# Frozen-bundle/process identity. The outer verifier has already matched both
# PAPERCUSP_SID and its launch-provenance marker against /proc before exporting
# VERIFY_TAURI_PID; capture the page/process identity again in the evidence set.
"$P014_TAURI_TOOL" page-state --pid "$P014_TAURI_PID" --strict --json \
  >"$P014_ACCEPTANCE_OUTPUT/page-state-initial.json"
"$P014_TAURI_TOOL" process-tree --pid "$P014_TAURI_PID" --strict --deep --json \
  >"$P014_ACCEPTANCE_OUTPUT/process-tree.json"

# 1. Work -> papercusp -> Work items. The deterministic setup is the real
# papercusp harness and its authoritative rows+summary writers; the observed
# exact values are captured and the visible label must be a lossless prefix of
# the accessible population statement. A page-only "loaded" label is refused.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "harnesses", slug: "papercusp", scope: "self", welcome: 0 } })'
if ! "$P014_TAURI_POLL" --selector '[data-testid="wi-count"]'; then
  # A customized dock may not have the panel mounted. Use the real Add-panel
  # catalogue and click the exact existing Work items entry; no backend write.
  p014_navigate '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Add panel"); if (!b) return false; b.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '[role="dialog"][aria-label="Panel catalog"]'
  p014_navigate '(() => { const x = [...document.querySelectorAll("button,[role=option],[role=menuitem]")].find((n) => n.textContent?.trim() === "Work items"); if (!x) return false; x.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '[data-testid="wi-count"]'
fi
p014_assert '(() => { const e = document.querySelector("[data-testid=wi-count]"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; if (!visible || !aria || /loaded/i.test(visible + " " + aria)) return false; if (visible === "—") return /^Count (loading|updating|unavailable)/.test(aria); return aria.includes(visible) && /(?:full corpus|all work items|match|item)/i.test(aria); })()'
p014_console_clean
p014_capture work-items 'JSON.stringify({ route: location.pathname + location.search, selector: "[data-testid=wi-count]", visible: document.querySelector("[data-testid=wi-count]")?.textContent?.trim(), aria: document.querySelector("[data-testid=wi-count]")?.getAttribute("aria-label"), expected: "visible count is corpus-scoped or explicit unknown/updating; accessible text carries the same value and population; loaded/page-only copy is forbidden" })'

# 2. Learning -> Observe -> Observations. The lview query is the route-level
# fixture; exact current values come from the paired page+summary writer and are
# captured. Visual and accessible copy must agree, including unknown/updating.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "observations" } })'
"$P014_TAURI_POLL" --selector '[data-testid="observations-count"]'
p014_assert '(() => { const e = document.querySelector("[data-testid=observations-count]"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; if (!visible || !aria || /loaded/i.test(visible + " " + aria)) return false; if (visible === "—") return /^Count (loading|updating|unavailable)/.test(aria); return aria.includes(visible) && /(?:full corpus|observation|match)/i.test(aria); })()'
p014_console_clean
p014_capture learning-observations 'JSON.stringify({ route: location.pathname + location.search, selector: "[data-testid=observations-count]", visible: document.querySelector("[data-testid=observations-count]")?.textContent?.trim(), aria: document.querySelector("[data-testid=observations-count]")?.getAttribute("aria-label"), stage: document.querySelector("[role=tab][aria-selected=true]")?.getAttribute("aria-label"), expected: "paired Observations count is corpus-scoped or explicit unknown/updating; loaded-page copy is forbidden" })'

# 3. Learning Improve under a deterministic impossible-match predicate. The
# unique session id is a fixture value that cannot be present in an authored
# idea/work-item row unless this exact verifier run wrote it (this script is
# read-only). The server-authored companion must therefore settle at 0 of 0;
# the title records the full Improve corpus and the 500-row wire cap. Scope the
# count to the inline tools: the scope banner intentionally reuses the visual
# match-count class, so a document-wide query selects the wrong element when
# the default `loop` scope is active.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "improvements" } })'
"$P014_TAURI_POLL" --selector 'input[aria-label="Search ideas and work"]'
P014_IMPROVE_SENTINEL="p014-no-match-${PAPERCUSP_SID}"
"$P014_TAURI_TOOL" type \
  --pid "$P014_TAURI_PID" \
  --strict \
  --clear \
  'input[aria-label="Search ideas and work"]' \
  "$P014_IMPROVE_SENTINEL" >/dev/null
"$P014_TAURI_POLL" \
  --eval 'document.querySelector(".pc-learning__inlinetools .pc-learning__matchcount")?.textContent?.trim() === "0 of 0"'
p014_assert '(() => { const e = document.querySelector(".pc-learning__inlinetools .pc-learning__matchcount"); if (!e) return false; const visible = (e.textContent || "").trim(); const title = e.getAttribute("title") || ""; return visible === "0 of 0" && /^Exact server-authored match count over \d[\d,]* merged Improve rows; at most 500 rows cross the sync wire\.$/.test(title); })()'
p014_console_clean
p014_capture learning-improve 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-learning__inlinetools .pc-learning__matchcount", query: document.querySelector("input[aria-label=\"Search ideas and work\"]")?.value, visible: document.querySelector(".pc-learning__inlinetools .pc-learning__matchcount")?.textContent?.trim(), title: document.querySelector(".pc-learning__inlinetools .pc-learning__matchcount")?.getAttribute("title"), expected: "unique impossible-match predicate settles to exact server-authored 0 of 0 over the full Improve corpus; at most 500 rows cross the wire" })'

# 4. Learning Retain uses the same impossible-match fixture. Its shared count
# formatter must expose exact zero against the complete selected Retain corpus;
# neither a loaded-row badge nor an inapplicable outcome count is admissible.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "learnings" } })'
"$P014_TAURI_POLL" --selector 'input[aria-label="Filter retained items"]'
P014_RETAIN_SENTINEL="p014-no-match-${PAPERCUSP_SID}"
"$P014_TAURI_TOOL" type \
  --pid "$P014_TAURI_PID" \
  --strict \
  --clear \
  'input[aria-label="Filter retained items"]' \
  "$P014_RETAIN_SENTINEL" >/dev/null
"$P014_TAURI_POLL" \
  --eval 'document.querySelector(".pc-learning__retained .pc-advpanel__count")?.textContent?.trim()?.startsWith("0 of ") === true'
p014_assert '(() => { const e = document.querySelector(".pc-learning__retained .pc-advpanel__count"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; return /^0 of \d[\d,]* match$/.test(visible) && aria.startsWith(visible) && /complete selected Retain corpus/i.test(aria) && !/loaded/i.test(aria); })()'
p014_console_clean
p014_capture learning-retain 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-learning__retained .pc-advpanel__count", query: document.querySelector("input[aria-label=\"Filter retained items\"]")?.value, visible: document.querySelector(".pc-learning__retained .pc-advpanel__count")?.textContent?.trim(), aria: document.querySelector(".pc-learning__retained .pc-advpanel__count")?.getAttribute("aria-label"), expected: "unique impossible-match predicate settles to exact zero over the complete selected Retain corpus; loaded-page fallback is forbidden" })'

# 5. Git bounded-history disclosure. The exact visible and aria values must
# encode the same match count and selected 100/300/500/1,000-commit window.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "git", slug: "papercusp", scope: "self" } })'
"$P014_TAURI_POLL" --selector '.pc-adv-gitgrid__count'
p014_assert '(() => { const e = document.querySelector(".pc-adv-gitgrid__count"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; const v = /^(\d[\d,]*) · latest (100|300|500|1,000) commits$/.exec(visible); const a = /^(\d[\d,]*) matches in latest (100|300|500|1,000) commits$/.exec(aria); return !!v && !!a && v[1] === a[1] && v[2] === a[2]; })()'
p014_console_clean
p014_capture git-history 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-adv-gitgrid__count", visible: document.querySelector(".pc-adv-gitgrid__count")?.textContent?.trim(), aria: document.querySelector(".pc-adv-gitgrid__count")?.getAttribute("aria-label"), expected: "N · latest L commits and aria N matches in latest L commits with identical N and L" })'

# 6. Run-log bounded-history disclosure. A customized Work dock may not carry
# the Run log panel, so mount the exact catalog entry and assert the filter
# engine's screen-reader scope against the canonical latest-300 window.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "harnesses", slug: "papercusp", scope: "self", welcome: 0 } })'
if ! "$P014_TAURI_POLL" --selector '.pc-adv-logs .pc-advpanel__filterbar[data-count-evidence="window"]'; then
  p014_navigate '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Add panel"); if (!b) return false; b.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '[role="dialog"][aria-label="Panel catalog"]'
  p014_navigate '(() => { const x = [...document.querySelectorAll("button,[role=option],[role=menuitem]")].find((n) => n.textContent?.trim() === "Run log"); if (!x) return false; x.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '.pc-adv-logs .pc-advpanel__filterbar[data-count-evidence="window"]'
fi
p014_assert '(() => { const bar = document.querySelector(".pc-adv-logs .pc-advpanel__filterbar[data-count-evidence=window]"); const scope = bar?.querySelector(".pc-sr-only")?.textContent?.trim(); return scope === "Filter option counts cover latest 300 events."; })()'
p014_console_clean
p014_capture logs 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-adv-logs .pc-advpanel__filterbar[data-count-evidence=window]", evidence: document.querySelector(".pc-adv-logs .pc-advpanel__filterbar")?.getAttribute("data-count-evidence"), accessibleScope: document.querySelector(".pc-adv-logs .pc-advpanel__filterbar .pc-sr-only")?.textContent?.trim(), expected: "window evidence; Filter option counts cover latest 300 events." })'

# 7. Coordination history is a separate /coord route, not the curated
# Conversations feed. It must state the returned latest-match population and
# its fixed 200-row ceiling in the visible text.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/coord", search: { panel: "history" } })'
"$P014_TAURI_POLL" \
  --eval '[...document.querySelectorAll("span")].some((e) => /^\d[\d,]* latest matches · up to 200$/.test((e.textContent || "").trim()))'
p014_assert '(() => { const e = [...document.querySelectorAll("span")].find((n) => /^\d[\d,]* latest matches · up to 200$/.test((n.textContent || "").trim())); return !!e; })()'
p014_console_clean
p014_capture coordination-history 'JSON.stringify({ route: location.pathname + location.search, visible: [...document.querySelectorAll("span")].find((e) => /^\d[\d,]* latest matches · up to 200$/.test((e.textContent || "").trim()))?.textContent?.trim(), expected: "N latest matches · up to 200" })'

# 8. Cupboard flat browse. The live worker response is the deterministic
# authority for this read-only run: All-facet count must equal the sum of every
# visible per-kind server facet, and the pagination label must expose the same
# exact total as "Showing loaded of total" rather than a page-one inference.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/cupboard", search: {} })'
"$P014_TAURI_POLL" --selector '[data-testid="cupboard-results"]'
"$P014_TAURI_POLL" --selector '[data-testid="cupboard-pagination"]'
p014_assert '(() => { const pagination = document.querySelector("[data-testid=cupboard-pagination] span"); const all = document.querySelector("[data-testid=cupboard-kind-count-all]"); if (!pagination || !all) return false; const m = /^Showing (\d[\d,]*) of (\d[\d,]*)$/.exec((pagination.textContent || "").trim()); const total = Number((all.textContent || "").replaceAll(",", "")); if (!m || !Number.isFinite(total)) return false; const loaded = Number(m[1].replaceAll(",", "")); const exact = Number(m[2].replaceAll(",", "")); const facets = [...document.querySelectorAll("[data-testid^=cupboard-kind-count-]")].filter((e) => e.getAttribute("data-testid") !== "cupboard-kind-count-all").map((e) => Number((e.textContent || "").replaceAll(",", ""))).filter(Number.isFinite); return loaded >= 0 && loaded <= exact && exact === total && facets.reduce((a, b) => a + b, 0) === total; })()'
p014_console_clean
p014_capture cupboard 'JSON.stringify({ route: location.pathname + location.search, pagination: document.querySelector("[data-testid=cupboard-pagination] span")?.textContent?.trim(), all: document.querySelector("[data-testid=cupboard-kind-count-all]")?.textContent?.trim(), kindFacets: Object.fromEntries([...document.querySelectorAll("[data-testid^=cupboard-kind-count-]")].map((e) => [e.getAttribute("data-testid"), e.textContent?.trim()])), expected: "Showing loaded of exact total; All equals exact total and sum of visible server-authored kind facets" })'

"$P014_TAURI_TOOL" page-state --pid "$P014_TAURI_PID" --strict --json \
  >"$P014_ACCEPTANCE_OUTPUT/page-state-final.json"

echo "P014_TAURI_ACCEPTANCE_OK pid=$P014_TAURI_PID output=$P014_ACCEPTANCE_OUTPUT"
