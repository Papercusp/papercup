import{o as H}from"./chunk-a1a4177d.js";import{t as R}from"./react-ea1d8b8b.js";import{t as q}from"./jsx-runtime-660d4162.js";import{r as B}from"./seam-570c8645.js";import{i as E}from"./SyncContext-10c8fc40.js";import{l as O,o as M}from"./dist-8935d6c3.js";import{t as I}from"./arrow-up-right-346a70f8.js";import{t as F}from"./heart-pulse-359f07bb.js";import{t as J}from"./Tooltip-98086d04.js";import{i as A,y as o}from"./theme-7f2f666e.js";var g=H(R(),1),C=["queen","bees","workItems","workFeed","loops","tokens","watchdog","deploy","plans","escalations","autonomy","observations","improvements","infra","suFleet","coordination","overwatch","scout","memory","toolEfficiency","contextInjection"],a=q(),N={ok:"good",warn:"warn",crit:"bad",unknown:"mute"},K={ok:"All systems healthy",warn:"Needs a look",crit:"Action needed",unknown:"Status unknown"},Q=3*6e4;function z(r,s){const c=Math.max(0,(s-r)/1e3);if(c<60)return`${Math.round(c)}s ago`;const i=c/60;return i<90?`${Math.round(i)}m ago`:`${Math.round(i/60)}h ago`}function L(r,s){if(r==null)return"for 24h+";const c=Math.max(0,(s-r)/6e4);return c<1?"just now":c<90?`for ${Math.round(c)}m`:c<2160?`for ${Math.round(c/60)}h`:`for ${Math.round(c/1440)}d`}function U(r){if(r&&typeof r=="object"){const s=r.content,c=Array.isArray(s)?s[0]?.text:void 0;if(typeof c=="string")try{return JSON.parse(c)}catch{return{}}return r}return{}}function na(){const r=E({queryName:"health.snapshot",args:{},staleTime:15e3}),s=E({queryName:"health.history",args:{},staleTime:6e4}),c=B().advNavigation,[,i]=O(c?.param??"tab",M),[k,v]=O("healthPanel",M),n=r.data?.[0],p=s.data?.[0],l=p&&typeof p=="object"&&typeof p.since=="object"&&p.since!==null&&typeof p.strips=="object"&&p.strips!==null?p:null,[d,S]=(0,g.useState)(()=>Date.now());(0,g.useEffect)(()=>{const e=setInterval(()=>S(Date.now()),15e3);return()=>clearInterval(e)},[]);const u=n?d-n.evaluatedAt>Q:!1,b=(0,g.useMemo)(()=>{if(!n||!l||n.overall==="ok"||n.overall==="unknown")return null;let e;for(const h of C){const f=n.panels[h];if(!f||f.status!==n.overall||f.ack)continue;const T=l.since[h];(e===void 0||(T??0)<(e??0))&&(e=T)}return e===void 0?null:L(e,d)},[n,l,d]);if(!n)return(0,a.jsxs)("div",{className:"pc-health pc-health--empty",children:[(0,a.jsx)("div",{className:"pc-health__placeholder",children:r.error?`Health unavailable — ${String(r.error)}`:r.loading?"Loading system health…":"System health is disabled."}),(0,a.jsx)(P,{})]});const $=e=>h=>{const f=e.match(/^\/adv\?tab=([\w-]+)/);f&&(h.preventDefault(),i(c?.targets[f[1]]??f[1]))},_=C.map(e=>n.panels[e]).filter(Boolean),y=_.filter(e=>!e.ack),m=y.filter(e=>e.status==="crit").length,x=y.filter(e=>e.status==="warn").length,w=_.filter(e=>e.ack).length,j=N[n.overall],t=()=>{r.invalidate?.(),s.invalidate?.()};return(0,a.jsxs)("div",{className:"pc-health",children:[u&&(0,a.jsxs)("div",{className:"pc-health__stale",role:"alert",children:["SNAPSHOT STALE — last computed ",z(n.evaluatedAt,d),". The health tick may be frozen (routine engine / bg host); the readings below are OLD."]}),(0,a.jsxs)("header",{className:"pc-health__bar","data-tone":u?"mute":j,children:[(0,a.jsx)("span",{className:`pc-health__dot pc-health__dot--${u?"mute":j}`,"aria-hidden":!0}),(0,a.jsx)(F,{size:15,"aria-hidden":!0}),(0,a.jsxs)("span",{className:"pc-health__overall",children:[K[n.overall],b?(0,a.jsxs)("span",{className:"pc-health__since",children:[" ",b]}):null]}),(0,a.jsxs)("div",{className:"pc-health__counts",children:[m>0&&(0,a.jsxs)("span",{className:"pc-health__count pc-health__count--bad",children:[m," red"]}),x>0&&(0,a.jsxs)("span",{className:"pc-health__count pc-health__count--warn",children:[x," yellow"]}),m===0&&x===0&&(0,a.jsx)("span",{className:"pc-health__count pc-health__count--good",children:"all green"}),w>0&&(0,a.jsxs)("span",{className:"pc-health__count",children:[w," ack’d"]})]}),(0,a.jsx)("span",{className:"pc-health__spacer"}),l?.overallStrip&&(0,a.jsx)(D,{cells:l.overallStrip,wide:!0}),(0,a.jsxs)("span",{className:"pc-health__checked",children:["checked ",z(n.evaluatedAt,d)]})]}),(0,a.jsx)("div",{className:`pc-health__grid${u?" pc-health__grid--stale":""}`,children:_.map(e=>(0,a.jsx)(G,{panel:e,onLink:$,nowMs:d,strip:l?.strips?.[e.key]??null,since:e.status!=="ok"&&e.status!=="unknown"?L(l?.since?.[e.key],d):null,expanded:k===e.key,transitions:l?.transitions?.filter(h=>h.panel===e.key).slice(0,8)??[],onToggle:()=>{v(k===e.key?null:e.key)},onChanged:t},e.key))}),(0,a.jsx)(P,{})]})}function D({cells:r,wide:s}){return(0,a.jsx)("span",{className:`pc-hstrip${s?" pc-hstrip--wide":""}`,"aria-label":"24h status history",title:"last 24h, oldest → newest",children:r.map((c,i)=>(0,a.jsx)("span",{className:`pc-hstrip__cell pc-hstrip__cell--${c===null?"none":N[c]}`},i))})}function G({panel:r,onLink:s,nowMs:c,strip:i,since:k,expanded:v,transitions:n,onToggle:p,onChanged:l}){const d=N[r.status],[S,u]=(0,g.useState)(!1),[b,$]=(0,g.useState)(""),[_,y]=(0,g.useState)(!1),[m,x]=(0,g.useState)(null),w=async t=>{y(!0),x(null);try{const e=await fetch(`/api/agent-tools/health/${t}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(t==="ack"?{panel:r.key,reason:b.trim(),ackedBy:"owner"}:{panel:r.key})}),h=U(await e.json().catch(()=>({})));if(!e.ok||h.ok===!1)throw new Error(String(h.error??`HTTP ${e.status}`));u(!1),$(""),l()}catch(e){x(e instanceof Error?e.message:String(e))}finally{y(!1)}},j=(()=>{const t=r.data?.gateway?.reasons;return Array.isArray(t)?t.filter(e=>typeof e=="string"):[]})();return(0,a.jsxs)("section",{className:`pc-hcard pc-hcard--${d}${r.ack?" pc-hcard--acked":""}${v?" pc-hcard--expanded":""}`,"data-panel":r.key,children:[(0,a.jsxs)("div",{className:"pc-hcard__head",children:[(0,a.jsx)("span",{className:`pc-hcard__dot pc-hcard__dot--${d}`,"aria-hidden":!0,title:r.status}),(0,a.jsx)("button",{type:"button",className:"pc-hcard__title",onClick:p,"aria-expanded":v,children:r.label}),k&&(0,a.jsxs)("span",{className:"pc-hcard__since",children:[r.status," ",k]}),r.link&&(0,a.jsx)(J,{label:`Open ${r.link.label}`,children:(0,a.jsx)("a",{className:"pc-hcard__link",href:r.link.href,onClick:s(r.link.href),"aria-label":`Open ${r.link.label}`,children:(0,a.jsx)(I,{size:12,"aria-hidden":!0})})})]}),r.ack&&(0,a.jsxs)("div",{className:"pc-hcard__ack",title:`acknowledged by ${r.ack.ackedBy}`,children:["ACK’D — ",r.ack.reason]}),(0,a.jsx)("div",{className:"pc-hcard__summary",title:r.error??r.summary,children:r.summary}),r.metrics.length>0&&(0,a.jsx)("div",{className:"pc-hcard__metrics",children:r.metrics.map((t,e)=>(0,a.jsxs)("span",{className:"pc-hcard__m","data-tone":t.tone?N[t.tone]:void 0,children:[(0,a.jsx)("b",{children:t.value}),(0,a.jsx)("span",{children:t.label})]},e))}),i&&(0,a.jsx)(D,{cells:i}),v&&(0,a.jsxs)("div",{className:"pc-hcard__detail",children:[j.length>0&&(0,a.jsx)("ul",{className:"pc-hcard__reasons",children:j.map((t,e)=>(0,a.jsx)("li",{children:t},e))}),n.length>0&&(0,a.jsx)("div",{className:"pc-hcard__transitions",children:n.map((t,e)=>(0,a.jsxs)("div",{className:"pc-hcard__transition",children:[(0,a.jsxs)("span",{"data-tone":N[t.to],children:[t.from," → ",t.to]}),(0,a.jsx)("span",{className:"pc-hcard__transition-at",children:z(t.at,c)}),t.summary&&(0,a.jsx)("span",{className:"pc-hcard__transition-sum",children:t.summary})]},e))}),(0,a.jsxs)("div",{className:"pc-hcard__actions",children:[r.ack?(0,a.jsx)("button",{type:"button",className:"pc-hcard__btn",disabled:_,onClick:()=>{w("unack")},children:"un-acknowledge"}):r.status==="warn"||r.status==="crit"?S?(0,a.jsxs)(a.Fragment,{children:[(0,a.jsx)("input",{className:"pc-hcard__ackinput",value:b,placeholder:"why is this accepted?",onChange:t=>$(t.target.value)}),(0,a.jsx)("button",{type:"button",className:"pc-hcard__btn",disabled:_||b.trim().length<3,onClick:()=>{w("ack")},children:"acknowledge"}),(0,a.jsx)("button",{type:"button",className:"pc-hcard__btn",disabled:_,onClick:()=>u(!1),children:"cancel"})]}):(0,a.jsx)("button",{type:"button",className:"pc-hcard__btn",onClick:()=>u(!0),children:"acknowledge…"}):null,m&&(0,a.jsx)("span",{className:"pc-hcard__note",children:m})]}),r.data!=null&&(0,a.jsx)("pre",{className:"pc-hcard__data",children:JSON.stringify(r.data,null,2).slice(0,4e3)})]})]})}function P(){return(0,a.jsx)("style",{children:`
      .pc-health {
        display: flex; flex-direction: column; gap: 9px;
        min-height: 0; flex: 1; padding: 11px 13px 15px;
      }
      .pc-health--empty { align-items: center; justify-content: center; }
      .pc-health__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 40px; }

      /* P-013: stale-snapshot banner */
      .pc-health__stale {
        padding: 7px 11px; border-radius: 9px; font-size: 11px; font-weight: 700;
        letter-spacing: 0; color: #fca5a5;
        border: 1px solid rgba(244, 63, 94, 0.55); background: rgba(244, 63, 94, 0.12);
      }
      .pc-health__grid--stale { opacity: 0.55; filter: saturate(0.6); }

      /* Overall status bar */
      .pc-health__bar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 11px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-health__bar[data-tone='bad'] { border-color: rgba(244, 63, 94, 0.45); background: rgba(244, 63, 94, 0.08); }
      .pc-health__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
      .pc-health__bar svg { color: var(--fg-dim, #b9d4e8); }
      .pc-health__overall { font-size: 12px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-health__since { font-weight: 600; color: var(--fg-mute, #7f9bb4); }
      .pc-health__counts { display: flex; gap: 5px; }
      .pc-health__count {
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
        padding: 1px 7px; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-health__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
      .pc-health__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
      .pc-health__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
      .pc-health__spacer { flex: 1; }
      .pc-health__checked { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-health__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .pc-health__dot--good { background: ${o.good}; }
      .pc-health__dot--warn { background: ${o.warn}; }
      .pc-health__dot--bad { background: ${o.bad}; }
      .pc-health__dot--mute { background: ${A.slate500.hex}; }

      /* P-007: 24h status strips */
      .pc-hstrip { display: inline-flex; gap: 1px; align-items: center; height: 5px; margin-top: 2px; }
      .pc-hstrip--wide { height: 7px; min-width: 144px; margin: 0 6px; }
      .pc-hstrip__cell { flex: 1; min-width: 2px; height: 100%; border-radius: 1px; background: rgba(148, 163, 184, 0.15); }
      .pc-hstrip__cell--good { background: rgb(from ${o.good} r g b / 0.75); }
      .pc-hstrip__cell--warn { background: rgb(from ${o.warn} r g b / 0.85); }
      .pc-hstrip__cell--bad { background: rgb(from ${o.bad} r g b / 0.9); }
      .pc-hstrip__cell--mute { background: rgba(148, 163, 184, 0.35); }
      .pc-hstrip__cell--none { background: rgba(148, 163, 184, 0.12); }

      /* Dense card grid — flat cards with a left status-stripe (compact pass) */
      .pc-health__grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr));
        gap: 7px; align-content: start;
      }
      .pc-hcard {
        display: flex; flex-direction: column; gap: 4px;
        padding: 7px 10px 8px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.13));
        border-left: 3px solid var(--card-accent, #475569);
        background: var(--bg-2, rgba(255, 255, 255, 0.035));
      }
      .pc-hcard--good { --card-accent: ${o.good}; }
      .pc-hcard--warn { --card-accent: ${o.warn}; }
      .pc-hcard--bad { --card-accent: ${o.bad}; }
      .pc-hcard--mute { --card-accent: ${A.slate500.hex}; opacity: 0.72; }
      .pc-hcard--acked { opacity: 0.6; border-left-style: dashed; }
      .pc-hcard--expanded { grid-column: 1 / -1; }
      .pc-hcard__head { display: flex; align-items: center; gap: 6px; }
      .pc-hcard__title {
        font-size: 10.5px; font-weight: 750; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg, #e7f7ff); flex: 1; min-width: 0; text-align: left;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: none; border: none; padding: 0; cursor: pointer; font-family: inherit;
      }
      .pc-hcard__since {
        font-size: 9px; font-weight: 700; text-transform: uppercase; white-space: nowrap;
        color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums;
      }
      .pc-hcard__ack {
        font-size: 9.5px; font-weight: 700; color: var(--fg-mute, #7f9bb4);
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.25)); border-radius: 5px;
        padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard__dot--good { background: ${o.good}; box-shadow: 0 0 5px rgb(from ${o.good} r g b / 0.7); }
      .pc-hcard__dot--warn { background: ${o.warn}; box-shadow: 0 0 5px rgb(from ${o.warn} r g b / 0.6); }
      .pc-hcard__dot--bad { background: ${o.bad}; box-shadow: 0 0 6px rgb(from ${o.bad} r g b / 0.7); }
      .pc-hcard__dot--mute { background: ${A.slate500.hex}; }
      .pc-hcard__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .pc-hcard__link {
        display: inline-flex; align-items: center; flex-shrink: 0;
        color: var(--fg-mute, #7f9bb4); text-decoration: none; opacity: 0.7;
      }
      .pc-hcard__link:hover { color: var(--fg, #e7f7ff); opacity: 1; }
      .pc-hcard__summary {
        font-size: 10.5px; line-height: 1.3; color: var(--fg-dim, #b9d4e8);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-hcard--expanded .pc-hcard__summary { white-space: normal; }
      .pc-hcard__metrics { display: flex; flex-wrap: wrap; gap: 1px 9px; }
      .pc-hcard__m {
        display: inline-flex; align-items: baseline; gap: 3px;
        font-size: 9.5px; color: var(--fg-mute, #7f9bb4); white-space: nowrap;
      }
      .pc-hcard__m b {
        font-size: 11px; font-weight: 740; color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-hcard__m span { text-transform: uppercase; letter-spacing: 0; font-weight: 600; }
      .pc-hcard__m[data-tone='bad'] b { color: #fca5a5; }
      .pc-hcard__m[data-tone='warn'] b { color: #fcd34d; }
      .pc-hcard__m[data-tone='mute'] { opacity: 0.6; }

      /* P-014: expanded detail */
      .pc-hcard__detail { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
      .pc-hcard__reasons { margin: 0; padding-left: 16px; font-size: 10.5px; color: #fcd34d; }
      .pc-hcard__transitions { display: flex; flex-direction: column; gap: 2px; }
      .pc-hcard__transition {
        display: flex; gap: 8px; align-items: baseline; font-size: 10px;
        color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
      }
      .pc-hcard__transition [data-tone='bad'] { color: #fca5a5; }
      .pc-hcard__transition [data-tone='warn'] { color: #fcd34d; }
      .pc-hcard__transition [data-tone='good'] { color: #6ee7b7; }
      .pc-hcard__transition-at { color: var(--fg-mute, #7f9bb4); }
      .pc-hcard__transition-sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .pc-hcard__actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .pc-hcard__btn {
        font-size: 10px; font-weight: 700; text-transform: uppercase; cursor: pointer;
        padding: 2px 8px; border-radius: 6px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.25)); background: transparent;
        font-family: inherit;
      }
      .pc-hcard__btn:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
      .pc-hcard__btn:disabled { opacity: 0.5; cursor: default; }
      .pc-hcard__ackinput {
        flex: 1; min-width: 140px; font-size: 11px; font-family: inherit;
        padding: 2px 7px; border-radius: 6px; color: var(--fg, #e7f7ff);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.25)); background: rgba(255,255,255,0.04);
      }
      .pc-hcard__note { font-size: 10px; color: #fca5a5; }
      .pc-hcard__data {
        margin: 0; font-size: 9.5px; line-height: 1.35; color: var(--fg-mute, #7f9bb4);
        max-height: 260px; overflow: auto; border-radius: 6px; padding: 7px 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(0,0,0,0.18);
      }
    `})}export{na as default};
