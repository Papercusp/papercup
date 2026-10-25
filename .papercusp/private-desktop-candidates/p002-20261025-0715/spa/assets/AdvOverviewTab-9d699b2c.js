import{o as oe}from"./chunk-a1a4177d.js";import{t as le}from"./react-ea1d8b8b.js";import{t as ce}from"./jsx-runtime-660d4162.js";import{r as de}from"./seam-570c8645.js";import{i as f}from"./SyncContext-10c8fc40.js";import{l as D,o as j,r as ee,u as te}from"./dist-8935d6c3.js";import{t as pe}from"./activity-eee43249.js";import{t as ve}from"./arrow-right-ade7d83e.js";import{t as re}from"./bell-fa944600.js";import{i as ue}from"./primitives-874c53bf.js";import{t as ge}from"./clipboard-list-cd3fe66e.js";import{t as me}from"./coins-cd59ec02.js";import{t as he}from"./file-text-24369a5e.js";import{t as we}from"./graduation-cap-1cb1abfb.js";import{t as fe}from"./heart-pulse-359f07bb.js";import{C as _e}from"./AdvShell-f1508106.js";import{t as xe}from"./list-checks-9226c852.js";import{t as be}from"./rocket-af71f71e.js";import{t as ye}from"./users-ab32a399.js";import{t as se}from"./Tooltip-98086d04.js";import{n as je}from"./useLexicon-e47d5e4a.js";import{D as Ne,ct as ke,it as Se}from"./plans-api-31ef3879.js";import{d as $e}from"./logic-90065575.js";import{n as Ae,t as Pe}from"./agent-display-8cca97c9.js";import{t as Le}from"./adv-roster-args-dd430931.js";import"./AgentsRunningPill-148e569c.js";import{r as Te}from"./open-dock-panel-caf66ea2.js";var v=oe(le(),1),e=ce();function Me(r){if(!r)return null;let s=null;for(const a of r.buckets)a.usagePct===null||!Number.isFinite(a.usagePct)||(s===null||a.usagePct>s)&&(s=a.usagePct);return s}function Fe(r){return r===void 0||!Number.isFinite(r)||r<=0?"$0":r<.01?`$${r.toFixed(4)}`:`$${r.toFixed(2)}`}function Oe(r){return!r||!Number.isFinite(r.liveAgents)?"—":String(r.liveAgents)}function ze(r){if(!r)return"—";const s=Number.isFinite(r.effective)?r.effective:r.cap,a=Number.isFinite(r.cap)?String(r.cap):"∞",n=Number.isFinite(r.inFlight)?r.inFlight:0;return s<r.cap?`${n} / eff ${s} / ${a}`:`${n} / ${a}`}function Ie(r){return(r??[]).filter(s=>s.paused).length}function Re(r,s=64){const a=Number(r.trim());return!Number.isInteger(a)||a<1||a>s?null:a}var Ce=8e3;function De(){const[r,s]=(0,v.useState)(null),[a,n]=(0,v.useState)(null),[o,u]=(0,v.useState)(null),[l,g]=(0,v.useState)(!1),d=(0,v.useRef)(!1),i=(0,v.useRef)(!1);(0,v.useEffect)(()=>{let m=!1;const N=()=>{fetch("/api/operator/rate-limit-config",{cache:"no-store"}).then(p=>p.ok?p.json():Promise.reject(new Error(`HTTP ${p.status}`))).then(p=>{m||(s(p.status??null),n(null))}).catch(p=>!m&&n(String(p?.message??p)))};N();const w=setInterval(N,Ce);return()=>{m=!0,clearInterval(w)}},[]);const c=async()=>{if(d.current=!1,i.current){i.current=!1,u(null);return}if(o===null)return;const m=Re(o);if(u(null),!(m===null||m===r?.config.maxSimultaneousAgents)){g(!0);try{const N=await fetch("/api/operator/rate-limit-config",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({maxSimultaneousAgents:m})});if(N.ok){const w=await N.json();s(p=>p&&{...p,config:w.config,fleet:{...p.fleet,cap:w.config.maxSimultaneousAgents}})}}catch{}finally{g(!1)}}},O=Me(r?.usage),Q=Ie(r?.buckets),W=o??(r?String(r.config.maxSimultaneousAgents):"");return(0,e.jsxs)("div",{className:"pc-overview__rate",title:a?`Fleet rate — unreachable: ${a}`:"Fleet rate / usage — edit max to throttle or open up the fleet (live, no restart)",children:[O!==null&&(0,e.jsxs)("span",{className:"pc-overview__rate-slot",title:"Worst provider rate-limit usage% across buckets that expose a ceiling (API-key paths only — subscription accounts expose none)",children:[(0,e.jsx)("span",{className:"pc-overview__rate-k",children:"usage"}),(0,e.jsx)("span",{className:"pc-overview__rate-v",children:`${Math.round(O)}%`})]}),(0,e.jsxs)("span",{className:"pc-overview__rate-slot",title:"LLM spend over the last hour (usage telemetry, all accounts)",children:[(0,e.jsx)("span",{className:"pc-overview__rate-k",children:"spend 1h"}),(0,e.jsx)("span",{className:"pc-overview__rate-v",children:Fe(r?.usage?.spendUsd)})]}),(0,e.jsxs)("span",{className:"pc-overview__rate-slot",title:"Agents alive fleet-wide right now (fresh presence heartbeats) — includes the interactive su/CLI sessions the spawn governor does not manage, so this is NOT bounded by the governed cap",children:[(0,e.jsx)("span",{className:"pc-overview__rate-k",children:"live"}),(0,e.jsx)("span",{className:"pc-overview__rate-v",children:Oe(r?.fleet)})]}),(0,e.jsxs)("span",{className:"pc-overview__rate-slot",title:"Rate-GOVERNED dispatches in flight vs the editable cap — the cap throttles governed spawns (Mug/fleet placements) only, never the interactive sessions counted under LIVE",children:[(0,e.jsx)("span",{className:"pc-overview__rate-k",children:"governed"}),(0,e.jsx)("span",{className:"pc-overview__rate-v",children:ze(r?.fleet)})]}),(0,e.jsxs)("span",{className:"pc-overview__rate-slot",children:[(0,e.jsx)("label",{className:"pc-overview__rate-k",htmlFor:"pc-fleet-max",title:"maxSimultaneousAgents — hard cap on simultaneous rate-governed dispatches (edit commits live: persists + propagates, no restart). Does not limit interactive su sessions.",children:"governed cap"}),(0,e.jsx)("input",{id:"pc-fleet-max",className:"pc-overview__rate-input",type:"number",min:1,max:64,value:W,disabled:!r||l,onFocus:()=>{d.current=!0,u(r?String(r.config.maxSimultaneousAgents):"")},onChange:m=>u(m.target.value),onBlur:()=>{c()},onKeyDown:m=>{m.key==="Enter"&&m.target.blur(),m.key==="Escape"&&(i.current=!0,u(null),d.current=!1,m.target.blur())}})]}),Q>0&&(0,e.jsxs)("span",{className:"pc-overview__rate-paused",title:"Governor buckets currently rate-limit paused",children:[Q," paused"]}),(0,e.jsx)("style",{children:`
        .pc-overview__rate { display: inline-flex; align-items: center; gap: 16px; }
        .pc-overview__rate-slot { display: inline-flex; flex-direction: column; gap: 1px; }
        .pc-overview__rate-k {
          font-size: 9px; font-weight: 760; letter-spacing: 0; text-transform: uppercase;
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-overview__rate-v {
          font-size: 16px; font-weight: 760; color: var(--fg, #e7f7ff);
          font-variant-numeric: tabular-nums; line-height: 1.1;
        }
        .pc-overview__rate-input {
          width: 52px; font-size: 15px; font-weight: 760; line-height: 1.1;
          font-variant-numeric: tabular-nums;
          color: var(--fg, #e7f7ff); background: transparent;
          border: 1px solid var(--border, #24435c); border-radius: 4px; padding: 0 4px;
        }
        .pc-overview__rate-input:focus { outline: none; border-color: var(--accent, #57b3ff); }
        .pc-overview__rate-paused {
          font-size: 10px; font-weight: 760; letter-spacing: 0; text-transform: uppercase;
          color: var(--warn, #ffb454); border: 1px solid currentColor; border-radius: 4px;
          padding: 1px 6px; align-self: center;
        }
      `})]})}var Ee=r=>/^system(?:$|[-_:/.])/i.test((r??"").trim());function E(r){if(!Number.isFinite(r)||r<0)return"?";const s=Math.floor(r/1e3);if(s<60)return`${s}s`;const a=Math.floor(s/60);if(a<60)return`${a}m`;const n=Math.floor(a/60);return n<24?`${n}h`:`${Math.floor(n/24)}d`}var G=r=>r?r.slice(0,8):"—";function Qe(r,s){if(!r)return null;const a=r.gate,n=a.verdictStale?"unknown":a.consecutiveReds>0?"red":a.verdictObservedAtMs!=null||a.lastGreenAtMs!=null?"green":"unknown",o=a.verdictObservedAtMs!=null?`verdict ${E(s-a.verdictObservedAtMs)} ago`:null,u=n==="red"?`gate RED — ${a.failingTests.length} failing${a.stalled?" · STALLED":""}${o?` · ${o}`:""}`:n==="green"?`gate green${o?` · ${o}`:""}`:"gate unknown — verdict stale",l=r.activeRun,g=l==null?null:l.active?`judging ${G(l.candidate)}${l.elapsedSec!=null?` · ${E(l.elapsedSec*1e3)} in`:""}`:"idle",d=r.deploy,i=d.greenPinBehindStaging,c=d.deployedBehindGreenPin,O=[{key:"staging",label:"staging",sha:G(d.stagingHead?.sha??r.gitSync.headSha),tag:i!=null?i>0?`+${i} unjudged`:"all green":null},{key:"green",label:"green pin",sha:G(d.greenPin?.sha),tag:a.lastGreenAtMs!=null?`green ${E(s-a.lastGreenAtMs)} ago`:null},{key:"live",label:"live :3070",sha:G(d.deployed?.sha),tag:c!=null&&c>0?`${c} behind green`:d.deployedAtMs!=null?`deployed ${E(s-d.deployedAtMs)} ago`:c===0?"current":null}];return{verdict:n,gateLine:u,runLine:g,failingCount:a.failingTests.length,refs:O}}function ae(r){return r===void 0||!Number.isFinite(r)||r<=0?"$0":r<.01?`$${r.toFixed(4)}`:`$${r.toFixed(2)}`}function qe(r,s,a,n=F-1){if(!r&&(!s||s.length===0))return null;const o=r?`${ae(r.h1.spendUsd)} 1h · ${ae(r.h24.spendUsd)} 24h`:"—",u=(s??[]).map(l=>{const g=l.rate?.utilization,d=l.rate?.utilization7d,i=(l.rate?.pausedUntil??0)>a,c=l.usageWalled?"walled":l.edgeThrottled?"edge":i?"paused":"ok";return{id:l.id,label:l.label||l.id,utilPct:typeof g=="number"&&Number.isFinite(g)?Math.round(g*100):null,util7dPct:typeof d=="number"&&Number.isFinite(d)?Math.round(d*100):null,state:c}}).sort((l,g)=>(g.utilPct??-1)-(l.utilPct??-1)).slice(0,n);return{headline:o,unavailable:(s??[]).filter(l=>!l.available).length,rows:u}}var F=6,x={plans:"plans",needsYou:"plans",agents:"harnesses",activity:"conversations",workItems:"harnesses",health:"health",learning:"learning",deploy:"git"};function Ge(r){if(!r)return{done:0,total:0,pct:0};const s=o=>r[o]??0,a=s("done"),n=s("todo")+s("wip")+s("blocked")+s("needs-human")+a;return{done:a,total:n,pct:n>0?Math.round(a/n*100):0}}function We(r,s=F){const a=n=>n.startStatus==="started"?0:n.status==="active"?1:n.status==="ready"?2:3;return r.filter(n=>n.status!=="shipped"&&n.status!=="superseded"&&!n.archived).slice().sort((n,o)=>a(n)-a(o)||(o.updated??"").localeCompare(n.updated??"")).slice(0,s)}function He(r,s=F){return r.filter(a=>{const n=a.tier;return n?n==="decision":a.needsHuman}).slice(0,s)}function Be(r){return r.filter(s=>{const a=s.tier;return a?a==="alert":!s.needsHuman&&(s.kind==="smoke-fail"||s.kind==="coord-escalation")}).length}function Ke(r,s=F){return r.slice(0,s)}function Ve(r,s=[]){const a=new Map,n=i=>{const c=a.get(i)??{open:0,total:0,opened24h:0,closed24h:0};return a.set(i,c),c};let o=0,u=0;for(const i of r){const c=n(i.kind);c.total+=i.n,o+=i.n,i.terminal||(c.open+=i.n,u+=i.n)}let l=0,g=0;for(const i of s){const c=n(i.kind);c.opened24h+=i.opened,c.closed24h+=i.closed,l+=i.opened,g+=i.closed}const d=[...a.entries()].map(([i,c])=>({kind:i,...c})).sort((i,c)=>c.open-i.open||c.total-i.total).slice(0,F);return{total:o,open:u,opened24h:l,closed24h:g,kinds:d}}function Ye(r,s=F){if(!r?.panels)return[];const a=n=>n==="crit"?0:n==="warn"?1:2;return Object.values(r.panels).filter(n=>n.status==="crit"||n.status==="warn").sort((n,o)=>a(n.status)-a(o.status)).slice(0,s)}function jt(){const r=_e(),s=je(),a=de().advNavigation,[,n]=D(a?.param??"tab",j),o=t=>n(a?.targets[t]??t),[,u]=D("inboxTier",j),l=async t=>{await o(x.needsYou),await u(t)},[,g]=D("plan",j),[,d]=D("agentsRoster",ee),[,i]=D("agentsFocus",j),[,c]=te({conv:j,fmsg:j,fsys:j}),[,O]=te({lsb:ee,lst:j}),Q=async()=>{await O({lsb:!0,lst:"accounts"})},W=async t=>{await o(x.plans),await g(t)},m=async t=>{await d(!0),await i(t)},N=async t=>{await o("conversations"),await c({conv:"feed",fmsg:t,fsys:"all"})},w=ke({includeArchived:!1,includeLegacy:!1}),p=Se(),k=f({queryName:"advRoster.list",args:Le(null),staleTime:8e3}),S=f({queryName:"dev.coordFeed",args:{system_only:!1,limit:80},staleTime:8e3}),V=r.harnessSlugs===null?{}:{harnessSlugs:[...r.harnessSlugs]},$=f({queryName:"workItems.stats",args:V,enabled:r.ready,staleTime:15e3}),Y=f({queryName:"workItems.delta24h",args:V,enabled:r.ready,staleTime:15e3}),z=f({queryName:"health.snapshot",args:{},staleTime:15e3}),I=f({queryName:"learning.releaseReadiness",staleTime:3e4}),A=f({queryName:"dev.gitPipeline",args:{},staleTime:15e3}),b=f({queryName:"operatorReports.latest",staleTime:3e4}),P=f({queryName:"usage.spend",args:{},staleTime:3e4}),L=f({queryName:"accounts.pool",staleTime:3e4}),J=(0,v.useMemo)(()=>We(w.data?.plans??[]),[w.data]),q=(0,v.useMemo)(()=>Ne(p.data?.groups??[]),[p.data]),H=(0,v.useMemo)(()=>He(q),[q]),U=(0,v.useMemo)(()=>Be(q),[q]),B=(0,v.useMemo)(()=>(k.data?.[0]?.active??[]).filter($e).map(t=>({ownerId:t.ownerId,label:t.label,intent:t.intent,liveness:t.liveness,currentPlanSlug:t.currentPlanSlug,role:t.role,agent:t.agent})),[k.data]),X=(0,v.useMemo)(()=>Ke(B),[B]),T=(0,v.useMemo)(()=>Ve($.data??[],Y.data??[]),[$.data,Y.data]),h=(0,v.useMemo)(()=>Qe(A.data?.[0],Date.now()),[A.data]),M=(0,v.useMemo)(()=>qe(P.data?.[0],L.data,Date.now()),[P.data,L.data]),C=z.data?.[0],K=(0,v.useMemo)(()=>Ye(C),[C]),R=I.data?.[0],Z=(0,v.useMemo)(()=>(S.data??[]).filter(t=>!Ee(t.from)).slice(0,10).map(t=>({id:t.msg_id,agent:t.from,kind:t.kind,summary:t.summary??t.body??null,status:null})),[S.data]);return(0,e.jsxs)("div",{className:"pc-overview",children:[(0,e.jsxs)("div",{className:"pc-overview__topbar",children:[(0,e.jsx)(De,{}),(0,e.jsx)("div",{className:"pc-overview__topbar-spacer"}),(0,e.jsx)(se,{label:"Alerts — smoke failures + escalations",children:(0,e.jsxs)("button",{type:"button",className:"pc-overview__alerts","data-has-alerts":U>0,"aria-label":"Open alerts",onClick:()=>{l("alert")},children:[(0,e.jsx)(re,{size:13,"aria-hidden":!0}),(0,e.jsx)("span",{children:U})]})})]}),(0,e.jsxs)("div",{className:"pc-overview__grid",children:[(0,e.jsx)(_,{icon:(0,e.jsx)(xe,{size:14,"aria-hidden":!0}),title:"Plans",count:w.data?.plans?.filter(t=>t.status==="active"||t.startStatus==="started").length,loading:w.loading&&!w.data,error:w.error,empty:J.length===0,emptyLabel:"No active plans",onOpen:()=>{o(x.plans)},children:J.map(t=>{const{done:y,total:ne,pct:ie}=Ge(t.itemCounts);return(0,e.jsx)("button",{type:"button",className:"pc-overview__rowbtn","aria-label":`Open plan ${t.title??t.slug}`,onClick:()=>{W(t.slug)},children:(0,e.jsxs)("span",{className:"pc-overview__plan",children:[(0,e.jsxs)("span",{className:"pc-overview__plan-head",children:[(0,e.jsx)("span",{className:"pc-overview__plan-title",title:t.title??t.slug,children:t.title??t.slug}),(0,e.jsxs)("span",{className:"pc-overview__plan-frac",children:[y,"/",ne]})]}),(0,e.jsx)("span",{className:"pc-overview__bar","aria-hidden":!0,children:(0,e.jsx)("span",{className:"pc-overview__bar-fill",style:{width:`${ie}%`}})})]})},t.slug)})}),(0,e.jsx)(_,{icon:(0,e.jsx)(re,{size:14,"aria-hidden":!0}),title:"Needs you",count:H.length,accent:"var(--warn)",loading:p.loading&&!p.data,error:p.error,empty:H.length===0,emptyLabel:"Nothing needs you right now",onOpen:()=>{l("decision")},children:H.map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-imp":t.importance,"aria-hidden":!0}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:t.body||t.title,children:t.title}),t.harnessSlug&&(0,e.jsx)("span",{className:"pc-overview__row-tag",children:t.harnessSlug})]},t.id))}),(0,e.jsx)(_,{icon:(0,e.jsx)(ye,{size:14,"aria-hidden":!0}),title:"Agents",count:B.length,accent:"var(--accent-strong)",loading:k.loading&&!k.data,error:k.error?String(k.error.message??k.error):null,empty:X.length===0,emptyLabel:"No live agents",onOpen:()=>{Te("adv:agents"),o(x.agents)},children:X.map(t=>{const y=Pe(t.label,s);return(0,e.jsx)("button",{type:"button",className:"pc-overview__rowbtn","aria-label":`Open ${y}'s session history`,onClick:()=>{m(t.ownerId)},children:(0,e.jsxs)("span",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-live":t.liveness,"aria-hidden":!0}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:t.intent||y,children:t.intent||y}),t.role&&(0,e.jsx)("span",{className:"pc-overview__row-tag",children:Ae(t.role,s)})]})},t.ownerId)})}),(0,e.jsx)(_,{icon:(0,e.jsx)(pe,{size:14,"aria-hidden":!0}),title:"Activity",accent:"var(--good)",loading:S.loading&&!S.data,error:S.error?String(S.error.message??S.error):null,empty:Z.length===0,emptyLabel:"No recent agent activity",onOpen:()=>{o(x.activity)},children:Z.map(t=>(0,e.jsx)("button",{type:"button",className:"pc-overview__rowbtn","aria-label":"Open this event in Conversations",onClick:()=>{N(t.id)},children:(0,e.jsxs)("span",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-actor",children:t.agent??"—"}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:t.summary??t.kind,children:t.summary??t.kind})]})},t.id))}),(0,e.jsxs)(_,{icon:(0,e.jsx)(ge,{size:14,"aria-hidden":!0}),title:"Work items",count:T.open,accent:"var(--warn)",loading:$.loading&&!$.data,error:$.error?String($.error.message??$.error):null,empty:T.total===0,emptyLabel:"No work items",onOpen:()=>{o(x.workItems)},children:[(T.opened24h>0||T.closed24h>0)&&(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-actor",children:"24h"}),(0,e.jsxs)("span",{className:"pc-overview__row-title",title:"Work items opened vs driven terminal in the last 24 hours (all kinds)",children:["+",T.opened24h," opened · −",T.closed24h," closed"]})]}),T.kinds.map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-title",children:(0,e.jsx)(ue,{kind:t.kind,size:"xs"})}),(0,e.jsxs)("span",{className:"pc-overview__row-tag",children:[t.open," open · ",t.total," all",t.opened24h>0||t.closed24h>0?` · +${t.opened24h}/−${t.closed24h}`:""]})]},t.kind))]}),(0,e.jsx)(_,{icon:(0,e.jsx)(me,{size:14,"aria-hidden":!0}),title:"Spend",count:M&&M.unavailable>0?M.unavailable:void 0,accent:"var(--warn)",loading:P.loading&&!P.data||L.loading&&!L.data,error:P.error?String(P.error.message??P.error):L.error?String(L.error.message??L.error):null,empty:!M,emptyLabel:"No usage telemetry yet",onOpen:()=>{Q()},children:M&&(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-actor",children:"spend"}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:"LLM spend over the last 1h / 24h (usage telemetry, all accounts; provider-reported cost where available)",children:M.headline})]}),M.rows.map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-acct":t.state,"aria-hidden":!0}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:`${t.label} — 5h window ${t.utilPct??"?"}%${t.util7dPct!=null?` · 7d ${t.util7dPct}%`:""}${t.state!=="ok"?` · ${t.state}`:""}`,children:t.label}),(0,e.jsxs)("span",{className:"pc-overview__row-tag",children:[t.utilPct!=null?`${t.utilPct}%`:"—",t.state!=="ok"?` · ${t.state}`:""]})]},t.id))]})}),(0,e.jsx)(_,{icon:(0,e.jsx)(be,{size:14,"aria-hidden":!0}),title:"Deploy",count:h?.failingCount||void 0,accent:h?.verdict==="red"?"var(--bad)":h?.verdict==="green"?"var(--good)":"var(--fg-mute)",loading:A.loading&&!A.data,error:A.error?String(A.error.message??A.error):null,empty:!h,emptyLabel:"No pipeline snapshot yet",onOpen:()=>{o(x.deploy)},children:h&&(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-bar":h.verdict==="green"?"pass":h.verdict==="red"?"fail":void 0,"aria-hidden":!0}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:h.gateLine,children:h.gateLine}),h.runLine&&(0,e.jsx)("span",{className:"pc-overview__row-tag",children:h.runLine})]}),h.refs.map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-actor pc-overview__row-actor--wide",children:t.label}),(0,e.jsx)("span",{className:"pc-overview__row-title",title:`${t.label} ${t.sha}`,children:t.sha}),t.tag&&(0,e.jsx)("span",{className:"pc-overview__row-tag",children:t.tag})]},t.key))]})}),(0,e.jsx)(_,{icon:(0,e.jsx)(he,{size:14,"aria-hidden":!0}),title:"Operator report",accent:"var(--accent-cool)",loading:b.loading&&!b.data,error:b.error?String(b.error.message??b.error):null,empty:!b.data||b.data.length===0,emptyLabel:"No operator report in the last 48h",onOpen:()=>{l("activity")},children:(b.data??[]).map((t,y)=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsxs)("span",{className:"pc-overview__row-title",title:t.excerpt??t.title,children:[t.title,y===0&&t.excerpt?` — ${t.excerpt}`:""]}),y===0&&(0,e.jsx)("span",{className:"pc-overview__row-tag",title:"The operator's own written status report — a narrative account; the other tiles read ground-truth state directly",children:"narrative"}),(0,e.jsxs)("span",{className:"pc-overview__row-tag",children:[E(Date.now()-t.createdAt)," ago"]})]},t.turnId))}),(0,e.jsx)(_,{icon:(0,e.jsx)(fe,{size:14,"aria-hidden":!0}),title:"Health",count:K.length,accent:"var(--bad)",loading:z.loading&&!z.data,error:z.error?String(z.error.message??z.error):null,empty:K.length===0,emptyLabel:C?C.overall==="ok"?"All systems healthy":`Overall: ${C.overall}`:"No health snapshot yet",onOpen:()=>{o(x.health)},children:K.map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-health":t.status,"aria-hidden":!0}),(0,e.jsxs)("span",{className:"pc-overview__row-title",title:t.summary,children:[t.label," — ",t.summary]})]},t.key))}),(0,e.jsx)(_,{icon:(0,e.jsx)(we,{size:14,"aria-hidden":!0}),title:"Learning",accent:"var(--good)",loading:I.loading&&!I.data,error:I.error?String(I.error.message??I.error):null,empty:!R?.report,emptyLabel:"No release-readiness report yet",onOpen:()=>{o(x.learning)},children:R?.report&&(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsxs)("span",{className:"pc-overview__row-title",children:["release gate: ",R.report.verdict??"unreadable"]}),(0,e.jsxs)("span",{className:"pc-overview__row-tag",children:[R.report.passed,"/",R.report.criteria.length," bars"]})]}),R.report.criteria.slice(0,F-1).map(t=>(0,e.jsxs)("div",{className:"pc-overview__row",children:[(0,e.jsx)("span",{className:"pc-overview__row-dot","data-bar":t.status,"aria-hidden":!0}),(0,e.jsx)("span",{className:"pc-overview__row-title",children:t.key}),(0,e.jsx)("span",{className:"pc-overview__row-tag",children:t.status})]},t.key))]})})]}),(0,e.jsx)("style",{children:`
        .pc-overview {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
          flex: 1;
          padding: 14px 16px 16px;
        }
        /* Top bar */
        .pc-overview__topbar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
        }
        .pc-overview__topbar-spacer { flex: 1; }
        .pc-overview__alerts {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 700;
          border-radius: 8px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
          color: var(--fg-mute, #7f9bb4);
          cursor: pointer;
        }
        .pc-overview__alerts[data-has-alerts='true'] {
          color: var(--bad, #f87171);
          border-color: color-mix(in srgb, var(--bad, #f87171), transparent 60%);
          background: var(--bad-bg, rgba(248, 113, 113, 0.10));
        }
        /* Tiles grid */
        .pc-overview__grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          grid-auto-rows: minmax(0, 1fr);
          gap: 12px;
          flex: 1;
          min-height: 0;
        }
        @container (max-width: 720px) { .pc-overview__grid { grid-template-columns: 1fr; } }
        .pc-overview__tile {
          display: flex;
          flex-direction: column;
          min-height: 0;
          border: 1px solid var(--tile-accent, rgba(125, 211, 252, 0.18));
          border-radius: 14px;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--tile-accent, #38bdf8), transparent 90%), transparent 42%),
            var(--bg-2, rgba(255, 255, 255, 0.035));
          overflow: hidden;
        }
        .pc-overview__tile-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.12));
          color: var(--fg, #e7f7ff);
        }
        .pc-overview__tile-head svg { color: var(--tile-accent, #7dd3fc); }
        .pc-overview__tile-title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
        .pc-overview__tile-count {
          font-size: 11px;
          font-weight: 700;
          color: var(--fg, #e7f7ff);
          background: color-mix(in srgb, var(--tile-accent, #7dd3fc) 18%, var(--bg-popover, #0d1829));
          border: 1px solid color-mix(in srgb, var(--tile-accent, #7dd3fc), transparent 48%);
          border-radius: 999px;
          padding: 1px 7px;
          min-width: 18px;
          text-align: center;
        }
        .pc-overview__tile-open {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0;
          color: var(--fg-mute, #7f9bb4);
          background: transparent;
          border: none;
          cursor: pointer;
        }
        .pc-overview__tile-open:hover { color: var(--fg, #e7f7ff); }
        .pc-overview__tile-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 8px 12px 10px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .pc-overview__tile-state { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); padding: 6px 0; }
        .pc-overview__tile-state[data-error='true'] { color: var(--bad, #f87171); }
        /* Plan rows */
        /* Flex on INNER spans only — WebKitGTK ignores flex on <button>. */
        .pc-overview__plan { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
        .pc-overview__plan-head { display: flex; align-items: baseline; gap: 8px; }
        .pc-overview__plan-title {
          flex: 1; min-width: 0;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          text-align: left;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__plan-frac { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-overview__bar { display: block; height: 5px; border-radius: 999px; background: var(--bg-4, rgba(255, 255, 255, 0.11)); overflow: hidden; }
        .pc-overview__bar-fill {
          display: block;
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--accent, #38bdf8), var(--good, #34d399));
          transition: width 240ms ease;
        }
        /* Generic list rows (needs-you / agents / activity) */
        .pc-overview__row { display: flex; align-items: center; gap: 7px; min-width: 0; width: 100%; }
        /* Clickable rows (plans / agents / activity deep-links) — a quiet
           button reset that keeps the row layout, plus a soft hover. */
        .pc-overview__rowbtn {
          display: block;
          border: none;
          background: transparent;
          font: inherit;
          color: inherit;
          text-align: left;
          width: 100%;
          margin: 0 -6px;
          padding: 3px 6px;
          border-radius: 7px;
          cursor: pointer;
          transition: background-color 120ms ease;
        }
        .pc-overview__rowbtn:hover { background: var(--bg-3, rgba(255, 255, 255, 0.07)); }
        .pc-overview__rowbtn:focus-visible {
          outline: 1px solid var(--tile-accent, #7dd3fc);
          outline-offset: -1px;
        }
        .pc-overview__row-dot {
          width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--fg-mute, #7f9bb4);
        }
        .pc-overview__row-dot[data-live='live'] { background: var(--good, #34d399); box-shadow: 0 0 6px color-mix(in srgb, var(--good, #34d399), transparent 50%); }
        .pc-overview__row-dot[data-live='idle'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-imp='urgent'] { background: var(--bad, #f87171); }
        .pc-overview__row-dot[data-imp='high'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-health='crit'] { background: var(--bad, #f87171); box-shadow: 0 0 6px color-mix(in srgb, var(--bad, #f87171), transparent 50%); }
        .pc-overview__row-dot[data-health='warn'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-bar='pass'] { background: var(--good, #34d399); }
        .pc-overview__row-dot[data-bar='fail'] { background: var(--bad, #f87171); }
        /* Spend tile account states (P-003): walled = hard red, edge = orange,
           paused = yellow, ok = green. */
        .pc-overview__row-dot[data-acct='ok'] { background: var(--good, #34d399); }
        .pc-overview__row-dot[data-acct='paused'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-acct='edge'] { background: var(--warn, #fbbf24); }
        .pc-overview__row-dot[data-acct='walled'] { background: var(--bad, #f87171); box-shadow: 0 0 6px color-mix(in srgb, var(--bad, #f87171), transparent 50%); }
        .pc-overview__row-actor {
          font-size: 10.5px; font-weight: 700; color: var(--fg-mute, #7f9bb4);
          flex-shrink: 0; min-width: 40px; max-width: 64px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        /* Deploy tile ref labels ("live :3070") need more room than coord actors. */
        .pc-overview__row-actor--wide { min-width: 56px; max-width: 80px; }
        .pc-overview__row-title {
          flex: 1; min-width: 0;
          font-size: 12px; color: var(--fg-dim, #b9d4e8);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pc-overview__row-tag {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
          color: var(--fg-mute, #7f9bb4);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
          border-radius: 5px; padding: 1px 5px; flex-shrink: 0;
        }
      `})]})}function _({icon:r,title:s,count:a,accent:n,loading:o,error:u,empty:l,emptyLabel:g,onOpen:d,children:i}){return(0,e.jsxs)("section",{className:"pc-overview__tile",style:n?{"--tile-accent":n}:void 0,children:[(0,e.jsxs)("div",{className:"pc-overview__tile-head",children:[r,(0,e.jsx)("span",{className:"pc-overview__tile-title",children:s}),typeof a=="number"&&a>0&&(0,e.jsx)("span",{className:"pc-overview__tile-count",children:a}),(0,e.jsx)(se,{label:`Open ${s}`,children:(0,e.jsxs)("button",{type:"button",className:"pc-overview__tile-open","aria-label":`Open ${s}`,onClick:d,children:["open ",(0,e.jsx)(ve,{size:11,"aria-hidden":!0})]})})]}),(0,e.jsx)("div",{className:"pc-overview__tile-body",children:u?(0,e.jsx)("div",{className:"pc-overview__tile-state","data-error":"true",children:u}):o?(0,e.jsx)("div",{className:"pc-overview__tile-state",children:"Loading…"}):l?(0,e.jsx)("div",{className:"pc-overview__tile-state",children:g}):i})]})}export{x as OVERVIEW_TILE_TARGETS,Be as countAlerts,jt as default,Qe as deriveDeployTile,qe as deriveSpendTile,E as fmtAge,Ge as planProgress,We as selectActivePlans,Ke as selectAgentRows,He as selectDecisions,Ye as selectUnhealthyPanels,Ve as summarizeWorkItemStats};
