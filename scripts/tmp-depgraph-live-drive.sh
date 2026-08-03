#!/usr/bin/env bash
# Live headless drive of the /adv dependency-graph pane (P-009, plan
# dependency-health-pane-2026-08-02) against an isolated Tauri shell booted by
# scripts/verify-tauri-headless.sh --boot-only.
#
# READ-ONLY: every interaction here writes a nuqs URL param and nothing else.
# No backend mutation, so the shared-live-DB caveat in the verify script's
# header does not apply to this drive.
#
# Usage: VERIFY_TAURI_PID=<pid> bash scripts/tmp-depgraph-live-drive.sh
set -uo pipefail

P="${VERIFY_TAURI_PID:?set VERIFY_TAURI_PID}"
# NB: --pid is a SUBCOMMAND option, not a global one — `tauri-agent-tools --pid X eval`
# fails with "unknown option '--pid'". It goes after the verb.
say() { printf '\n=== %s ===\n' "$*"; }
# eval returns the JS value; we print it raw so each step is auditable.
ev() { tauri-agent-tools eval --pid "$P" "$1"; }

say "0. bridge + origin health"
ev "
  Promise.all([
    fetch('/api/health').then(r=>r.status).catch(e=>'ERR:'+e.message),
    Promise.resolve(location.href),
    Promise.resolve(document.title)
  ]).then(v=>JSON.stringify({apiHealth:v[0], href:v[1], title:v[2]}))
"

say "1. navigate to the Work tab for the papercusp pot (67 real dep edges)"
ev "location.href = '/adv?tab=harnesses&slug=papercusp&scope=self&welcome=0'; 'navigating'"
sleep 12

say "2. THE PANE IS REAL: it mounted, elkjs laid it out, nodes exist"
# Poll until the SVG nodes appear (elkjs is a lazy ~1MB import + async layout).
for i in $(seq 1 30); do
  n=$(ev "document.querySelectorAll('.pc-depgraph g.pc-depgraph__node').length" 2>/dev/null | tr -d '[:space:]')
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  [ "$n" -gt 0 ] && break
  sleep 3
done
ev "
  (() => {
    const p = document.querySelector('.pc-depgraph');
    if (!p) return JSON.stringify({paneMounted:false});
    const nodes = p.querySelectorAll('g.pc-depgraph__node');
    const edges = p.querySelectorAll('path.pc-depgraph__edge');
    return JSON.stringify({
      paneMounted: true,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      countChip: p.querySelector('.pc-advpanel__chip')?.textContent?.trim() ?? null,
      a11yListItems: p.querySelectorAll('ul.pc-depgraph__a11y li').length,
      planMarkers: p.querySelectorAll('rect.pc-depgraph__node-planmark').length,
      danglingNodes: p.querySelectorAll('g.pc-depgraph__node--dangling').length,
      firstNodeIds: [...nodes].slice(0,3).map(g => g.querySelector('.pc-depgraph__node-id')?.textContent)
    });
  })()
"

say "3. THE INTERLOCK: click a graph node -> ?sel written -> Detail follows"
ev "
  (() => {
    const g = document.querySelector('.pc-depgraph g.pc-depgraph__node');
    if (!g) return JSON.stringify({clicked:false});
    const id = g.querySelector('.pc-depgraph__node-id')?.textContent;
    g.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
    return JSON.stringify({clicked:true, clickedId:id});
  })()
"
sleep 6
ev "
  (() => {
    const sel = new URL(location.href).searchParams.get('sel');
    const d = document.querySelector('.pc-adv-detail');
    return JSON.stringify({
      urlSel: sel,
      detailId: d?.querySelector('.pc-adv-detail__id')?.textContent?.trim() ?? null,
      detailTitle: d?.querySelector('.pc-adv-detail__title')?.textContent?.trim() ?? null,
      selectedNodes: document.querySelectorAll('g.pc-depgraph__node--selected').length
    });
  })()
"

say "4. THE A11Y LIST drives the SAME selection (P-006 equivalent control surface)"
ev "
  (() => {
    const btns = [...document.querySelectorAll('.pc-depgraph ul.pc-depgraph__a11y button')];
    const cur = new URL(location.href).searchParams.get('sel');
    const other = btns.find(b => !b.textContent.startsWith(cur + ' '));
    if (!other) return JSON.stringify({clicked:false, n:btns.length});
    const label = other.textContent.trim().slice(0,60);
    other.click();
    return JSON.stringify({clicked:true, label});
  })()
"
sleep 6
ev "
  (() => {
    const d = document.querySelector('.pc-adv-detail');
    return JSON.stringify({
      urlSel: new URL(location.href).searchParams.get('sel'),
      detailId: d?.querySelector('.pc-adv-detail__id')?.textContent?.trim() ?? null,
      ariaCurrent: document.querySelectorAll('.pc-depgraph__a11y button[aria-current=\"true\"]').length
    });
  })()
"

say "5. P-008 HEALTH MODE: the 'Issues only' toggle writes dgh and narrows the graph"
ev "
  (() => {
    const b = [...document.querySelectorAll('.pc-depgraph button')].find(x => /Issues only/.test(x.textContent));
    if (!b) return JSON.stringify({found:false});
    b.click();
    return JSON.stringify({found:true, was:b.getAttribute('aria-pressed')});
  })()
"
sleep 6
ev "
  (() => {
    const p = document.querySelector('.pc-depgraph');
    const b = [...p.querySelectorAll('button')].find(x => /Issues only/.test(x.textContent));
    return JSON.stringify({
      dgh: new URL(location.href).searchParams.get('dgh'),
      ariaPressed: b?.getAttribute('aria-pressed'),
      nodeCount: p.querySelectorAll('g.pc-depgraph__node').length,
      chip: p.querySelector('.pc-advpanel__chip')?.textContent?.trim() ?? null,
      emptyMsg: p.querySelector('.pc-advpanel__empty')?.textContent?.trim() ?? null
    });
  })()
"

say "6. console errors during the whole drive"
tauri-agent-tools logs --pid "$P" --console 2>/dev/null | tail -25 || true
