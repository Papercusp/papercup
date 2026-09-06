#!/usr/bin/env bash
# Unit 5 live probe: the quick panel palette on the cloud portal (:3081)
# (plan portal-quick-panel-palette-2026-09-06 P-004 / P-005; D-001 panel-not-rail-app,
# D-003 qp-prefixed keys + no chat sidebar, D-004 /internal/docs proxied).
# Drives :3081 with the verdict daemon and writes one evidence file + screenshots.
set -u
REPORT_DIR="${REPORT_DIR:-$HOME/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06}"
mkdir -p "$REPORT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$REPORT_DIR/live-probe-$STAMP.txt"
BASE="${BASE:-http://127.0.0.1:3081}"
WAIT_MS="${WAIT_MS:-5000}"

log() { printf '%s\n' "$*" | tee -a "$OUT"; }
js() { verdict js "$1" 2>&1 | head -c "${2:-900}"; }
# Async in-page work: run it, park the result on window, read it back after a wait.
ajs() { # slot expr(async body returning a value)
  verdict js "(async()=>{try{window.$1=JSON.stringify(await (async()=>{$2})())}catch(e){window.$1='ERR:'+(e&&e.message||e)}})();'started'" >/dev/null 2>&1
  verdict wait "${3:-3000}" >/dev/null 2>&1
  verdict js "window.$1" 2>&1 | head -c 900
}
goto() { verdict goto "$1" >/dev/null 2>&1 || log "goto-failed: $1"; verdict wait "$WAIT_MS" >/dev/null 2>&1; }

panel_state='(()=>{const d=document.querySelector("section.shell-panel--quick[role=dialog]");if(!d)return "NO-QUICK-DIALOG";const p=d.querySelector(".pc-qp");const r=d.getBoundingClientRect();const tabs=[...d.querySelectorAll(".pc-qp__tab")].map(t=>t.textContent.trim()+(t.getAttribute("data-state")==="active"?"*":""));return JSON.stringify({label:d.getAttribute("aria-label"),rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],vw:innerWidth,vh:innerHeight,pcqp:!!p,pcqpPos:p?getComputedStyle(p).position:null,pcqpPadL:p?getComputedStyle(p).paddingLeft:null,tabs,loading:d.textContent.includes("Loading Quick panel"),chatSidebar:!!d.querySelector(".op-chat-sidebar"),bodyHasOpChat:document.body.classList.contains("has-op-chat")})})()'
prompts_state='(()=>{const d=document.querySelector("section.shell-panel--quick");if(!d)return "NO-QUICK-DIALOG";return JSON.stringify({rowgroups:d.querySelectorAll(".pc-qp__rowgroup").length,treeitems:d.querySelectorAll("[role=treeitem]").length,empty:[...d.querySelectorAll(".pc-qp__empty")].map(e=>e.textContent.trim().slice(0,80)),search:!!d.querySelector(".pc-qp__search")})})()'
click_tab() { verdict js "(()=>{const b=[...document.querySelectorAll('.pc-qp__tab')].find(t=>/$1/i.test(t.textContent));if(!b)return 'NO-TAB';b.click();return 'clicked:'+b.textContent.trim()})()" 2>&1 | head -c 120; }

log "PROBE_START $STAMP base=$BASE"
PID=$(ss -ltnpH 'sport = :3801' | grep -oP 'pid=\K[0-9]+' | head -1)
log "backend-3801 pid=$PID release=$(readlink /proc/$PID/cwd 2>/dev/null | grep -o 'releases/[^/]*')"
log "health-3081: $(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/health")"

log "=== A deep link ?panel=quick renders the palette in its own frame (D-001)"
goto "$BASE/?app=home&panel=quick"
log "url: $(verdict url 2>&1)"
log "panel: $(js "$panel_state")"
verdict wait 3000 >/dev/null 2>&1
log "panel-after-wait: $(js "$panel_state")"
log "prompts: $(js "$prompts_state")"
verdict screenshot "$REPORT_DIR/screenshot-panel-prompts.png" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/screenshot-panel-prompts.png"

log "=== B prompts tab reads saved prompts through the sync passthrough (P-004 read)"
log "sync-read: $(ajs __e8071r 'const r=await fetch("/api/agent-mcp/saved-prompts");return {status:r.status,count:((await r.json().catch(()=>({}))).prompts||[]).length}' 3000)"

log "=== C brainstorm tab mounts; its key is qp-prefixed (D-003)"
log "click: $(click_tab Brainstorm)"
verdict wait 4000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "brainstorm: $(js '(()=>{const d=document.querySelector("section.shell-panel--quick");if(!d)return "NO-QUICK-DIALOG";return JSON.stringify({pane:!!d.querySelector(".pc-qp__brainstorm"),bsbar:!!d.querySelector(".pc-qp__bsbar"),empty:[...d.querySelectorAll(".pc-qp__empty")].map(e=>e.textContent.trim().slice(0,80)),tabs:[...d.querySelectorAll(".pc-qp__tab")].map(t=>t.textContent.trim()+(t.getAttribute("data-state")==="active"?"*":""))})})()')"
verdict screenshot "$REPORT_DIR/screenshot-panel-brainstorm.png" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/screenshot-panel-brainstorm.png"

log "=== D docs tab: iframe + /internal/docs/* proxied on this origin (D-004)"
log "click: $(click_tab Docs)"
verdict wait 3000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "docs-frame: $(js '(()=>{const f=document.querySelector("section.shell-panel--quick iframe.pc-qp__docsframe");return f?JSON.stringify({src:f.getAttribute("src"),w:f.clientWidth,h:f.clientHeight}):"NO-IFRAME"})()')"
log "docs-fetch: $(ajs __e8071d 'const a=await fetch("/internal/docs/search-palette.html");const t=await a.text();const b=await fetch("/internal/docs/pagefind/pagefind-ui.js");return {page:a.status,pageType:a.headers.get("content-type"),hasPagefind:t.includes("pagefind-ui.js"),asset:b.status,assetType:b.headers.get("content-type")}' 4000)"
verdict screenshot "$REPORT_DIR/screenshot-panel-docs.png" >/dev/null 2>&1 && log "screenshot: $REPORT_DIR/screenshot-panel-docs.png"

log "=== E trigger beside the launcher opens/closes the panel"
goto "$BASE/?app=home"
log "trigger: $(js '(()=>{const b=document.querySelector(".quick-panel-trigger");if(!b)return "NO-TRIGGER";const l=document.querySelector(".launcher-trigger");const order=l&&b?(l.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?"after-launcher":"before-launcher"):"?";b.click();return JSON.stringify({label:b.getAttribute("aria-label"),kbd:(b.querySelector("kbd")||{}).textContent,order})})()')"
verdict wait 2500 >/dev/null 2>&1
log "url-after-click: $(verdict url 2>&1)"
log "expanded: $(js '(document.querySelector(".quick-panel-trigger")||{getAttribute:()=>null}).getAttribute("aria-expanded")')"
log "close: $(js '(()=>{const b=document.querySelector("section.shell-panel--quick header button");if(!b)return "NO-CLOSE";b.click();return "clicked"})()')"
verdict wait 2000 >/dev/null 2>&1
log "url-after-close: $(verdict url 2>&1)"

log "=== F ⌘J chord toggles; from the launcher it SWITCHES (one exclusive slot)"
log "chord-open: $(js 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"j",metaKey:true,bubbles:true,cancelable:true}));"sent"')"
verdict wait 2500 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "chord-close: $(js 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"j",metaKey:true,bubbles:true,cancelable:true}));"sent"')"
verdict wait 2000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "chord-k-then-j: $(js 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",metaKey:true,bubbles:true,cancelable:true}));"sent"')"
verdict wait 2000 >/dev/null 2>&1
log "url-after-k: $(verdict url 2>&1)"
log "switch: $(js 'window.dispatchEvent(new KeyboardEvent("keydown",{key:"j",metaKey:true,bubbles:true,cancelable:true}));"sent"')"
verdict wait 2500 >/dev/null 2>&1
log "url-after-j: $(verdict url 2>&1)"
log "dialogs: $(js 'JSON.stringify([...document.querySelectorAll("[role=dialog]")].map(d=>d.getAttribute("aria-label")))')"

log "=== G no key collision: the dev console keeps tab=pg while the palette switches tabs (D-003)"
goto "$BASE/?app=dev&tab=pg&panel=quick"
log "click: $(click_tab Brainstorm)"
verdict wait 3000 >/dev/null 2>&1
log "url: $(verdict url 2>&1)"
log "dev-active: $(js 'JSON.stringify([...document.querySelectorAll(".pc-dev-tab.is-active,[role=tab][aria-selected=true]")].map(e=>e.textContent.trim().slice(0,30)))')"

log "=== H D-010 write: create + remove a probe prompt node, same-origin AND sibling-origin (WI-2147102 gap)"
goto "$BASE/?app=home&panel=quick"
log "write-same-origin: $(ajs __e8071w 'const mk=await fetch("/api/agent-mcp/saved-prompts/node",{method:"POST",headers:{"content-type":"text/plain;charset=UTF-8"},body:JSON.stringify({title:"e8071 unit5 probe '"$STAMP"'",body:"probe — safe to delete",harness:null,parentId:null})});const j=await mk.json().catch(()=>({}));let rm=null;if(j.prompt&&j.prompt.id){const r=await fetch("/api/agent-mcp/saved-prompts/node/remove",{method:"POST",headers:{"content-type":"text/plain;charset=UTF-8"},body:JSON.stringify({id:j.prompt.id,harness:null})});rm=r.status}return {create:mk.status,id:j.prompt&&j.prompt.id||null,err:j.error||j.detail||null,remove:rm}' 5000)"
log "write-sibling-origin: $(ajs __e8071s 'const sib=location.origin.includes("127.0.0.1")?location.origin.replace("127.0.0.1","localhost"):location.origin.replace("localhost","127.0.0.1");try{const mk=await fetch(sib+"/api/agent-mcp/saved-prompts/node",{method:"POST",headers:{"content-type":"text/plain;charset=UTF-8"},body:JSON.stringify({title:"e8071 unit5 sibling probe '"$STAMP"'",body:"probe — safe to delete",harness:null,parentId:null})});const j=await mk.json().catch(()=>({}));let rm=null;if(j.prompt&&j.prompt.id){const r=await fetch("/api/agent-mcp/saved-prompts/node/remove",{method:"POST",headers:{"content-type":"text/plain;charset=UTF-8"},body:JSON.stringify({id:j.prompt.id,harness:null})});rm=r.status}return {sib,create:mk.status,id:j.prompt&&j.prompt.id||null,remove:rm}}catch(e){return {sib,error:String(e&&e.message||e)}}' 5000)"

log "=== console (errors)"
verdict console 2>&1 | grep -iE 'error|uncaught' | head -10 | tee -a "$OUT" >/dev/null
log "PROBE_END $(date -u +%Y%m%dT%H%M%SZ)"
echo "EVIDENCE=$OUT"
