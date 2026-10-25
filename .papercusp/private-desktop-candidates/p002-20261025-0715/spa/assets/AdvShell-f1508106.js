const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/TasksRosterPanel-1c084199.js","assets/TasksRosterPanel-bf7bcc32.js","assets/chunk-a1a4177d.js","assets/KillTaskControl-a1551758.js","assets/Button-37ac543f.js","assets/dist-b1ffc5f0.js","assets/jsx-runtime-660d4162.js","assets/react-ea1d8b8b.js","assets/SyncContext-10c8fc40.js","assets/dist-8935d6c3.js"])))=>i.map(i=>d[i]);
import{o as ke}from"./chunk-a1a4177d.js";import{t as Se}from"./react-ea1d8b8b.js";import{n as Te,t as Ae}from"./preload-helper-9c81c42c.js";import{t as Ee}from"./jsx-runtime-660d4162.js";import{i as oe}from"./SyncContext-10c8fc40.js";import{i as Re}from"./lazy-with-retry-73f6bdbd.js";import{l as _,o as Q,r as C,s as H}from"./dist-8935d6c3.js";import{a as Z,s as ee}from"./client-975cebd8.js";import{a as M}from"./browser-workspace-9e9d41bf.js";import{t as je}from"./Modal-429fa5c5.js";import{t as w}from"./hotkeys-152fbf6c.js";import{i as Oe,n as Ne,r as Le}from"./navigation-e5e2a2f7.js";import{n as Ce}from"./portal-embed-97c967eb.js";import{t as Me}from"./createLucideIcon-7dfd863d.js";import{t as Ie}from"./activity-eee43249.js";import{n as De,t as Pe}from"./layout-dashboard-5b9b6029.js";import{t as ze}from"./boxes-d1176d3c.js";import{t as Be}from"./calendar-clock-4326068b.js";import{t as He}from"./chart-column-2018ec80.js";import{t as Fe}from"./check-9d77ffba.js";import{t as We}from"./chevron-down-9ec1bdf6.js";import{t as Ve}from"./file-text-24369a5e.js";import{t as Ge}from"./flask-conical-a307bcbc.js";import{t as Ke}from"./gauge-f9eaf3dd.js";import{t as $e}from"./git-branch-7147c252.js";import{t as qe}from"./graduation-cap-1cb1abfb.js";import{t as Ue}from"./heart-pulse-359f07bb.js";import{t as Ye}from"./lightbulb-8b2b3bb1.js";import{n as Je,t as Xe}from"./CreateHarnessPicker-9ac83a32.js";import{t as Qe}from"./list-checks-9226c852.js";import{t as Ze}from"./maximize-2-b9ff526c.js";import{t as et}from"./message-circle-23cdbc08.js";import{t as tt}from"./minimize-2-a0f47f77.js";import{t as at}from"./monitor-play-f782da48.js";import{t as rt}from"./settings-26522036.js";import{t as nt}from"./trending-up-4377fdf8.js";import{t as st}from"./trophy-3908cbc0.js";import{t as te}from"./workflow-91be12df.js";import{t as ot}from"./Tooltip-98086d04.js";import{t as ie}from"./Popover-a4cd9d66.js";import{n as it,t as lt}from"./scope-6d68a1b4.js";import{i}from"./theme-7f2f666e.js";/* empty css                         */import{n as x,t as ct}from"./adv-navigation-9b6bc29f.js";import{t as dt}from"./pot-label-e96b7cbc.js";import{t as k}from"./dist-fe5565f3.js";import{t as ht}from"./AgentsRunningPill-148e569c.js";import{i as pt,n as ut,r as ft,t as bt}from"./dist-e7778137.js";import{n as gt}from"./hive-groups-b70cc85d.js";var mt=[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}],["path",{d:"M12 7v5l4 2",key:"1fdv2h"}]],vt=Me("history",mt),p=ke(Se(),1),xt="__all__";function wt(e){const{projectSlugs:r,urlSlug:n,urlScope:s,persisted:l}=e;return r.length===0?{}:s==="all"?{}:n&&r.includes(n)?{}:l&&l!=="__all__"&&r.includes(l)?{setSlug:l,setScope:"expanded"}:{setScope:"all"}}var t=Ee();Te();var _t=Re(()=>Ae(()=>import("./TasksRosterPanel-1c084199.js"),__vite__mapDeps([0,1,2,3,4,5,6,7,8,9])));function yt(e){if(!e)return 0;const r=e.live?.scan?.processes;return typeof r=="number"&&r>0?r:kt(e.summary?.byState)}function kt(e){return e?(e.running??0)+(e.starting??0):0}function St(){const[e,r]=_("tasks",C.withDefault(!1)),{data:n}=oe({queryName:"taskManager.inventory",args:{live:!0,countsOnly:!0},staleTime:1e4}),s=n?.[0];if(!s?.enabled)return null;const l=yt(s);return l===0?null:(0,t.jsx)("div",{className:"pc-advshell__tasks-pill-wrap",children:(0,t.jsx)(ie,{open:e,onOpenChange:c=>{r(c)},trigger:(0,t.jsxs)("button",{type:"button",className:"pc-advshell__action pc-advshell__action--tasks","data-testid":"tasks-running-pill","aria-expanded":e,"aria-controls":"pc-advshell-tasks-pop",children:[(0,t.jsx)(Ie,{size:11,"aria-hidden":!0}),l," ",l===1?"process":"processes"]}),tooltipLabel:"Every Papercusp process running right now — who launched it, for which work-item, and what it is consuming",side:"bottom",align:"end",ariaLabel:"Task manager",contentClassName:"pc-advshell__tasks-pop",children:(0,t.jsx)("div",{id:"pc-advshell-tasks-pop","data-testid":"tasks-running-pop",children:(0,t.jsx)(p.Suspense,{fallback:(0,t.jsx)("div",{className:"pc-tasks-roster__loading",children:"Scanning…"}),children:(0,t.jsx)(_t,{active:e})})})})})}var W=["overview","enterprise","hud","brainstorm","harnesses","health","prs","insights","conversations","learning","settings","docs","history","git","stats","testing","plans","workflows","calendar","frames","evals"],V=new Set([]),Tt=new Set([...V,...W]);function At(e,r){return r&&!Tt.has(e)?"overview":e}function Et(e,r){return r?e.filter(n=>V.has(n.id)):[...e]}var F=[{id:"overview",label:"Overview",icon:Pe,accent:i.indigo400.hex,accentRgb:i.indigo400.rgb},{id:"enterprise",label:"Enterprise",icon:te,accent:i.blue400.hex,accentRgb:i.blue400.rgb},{id:"hud",label:"HUD",icon:Ke,accent:i.teal300.hex,accentRgb:i.teal300.rgb},{id:"brainstorm",label:x.brainstorm,icon:Ye,accent:"var(--accent)",accentRgb:"var(--accent-rgb, 56, 189, 248)"},{id:"plans",label:x.plans,icon:Qe,accent:i.amber500.hex,accentRgb:i.amber500.rgb},{id:"workflows",label:"Workflows",icon:te,accent:i.blue400.hex,accentRgb:i.blue400.rgb},{id:"calendar",label:x.calendar,icon:Be,accent:i.teal400.hex,accentRgb:i.teal400.rgb},{id:"harnesses",label:"Work",icon:ze,accent:i.violet400.hex,accentRgb:i.violet400.rgb},{id:"health",label:x.health,icon:Ue,accent:i.rose500.hex,accentRgb:i.rose500.rgb},{id:"frames",label:x.frames,icon:at,accent:"var(--accent-strong, var(--accent))",accentRgb:"var(--accent-rgb, 56, 189, 248)"},{id:"git",label:x.git,icon:$e,accent:i.green500.hex,accentRgb:i.green500.rgb},{id:"stats",label:x.stats,icon:He,accent:i.violet300.hex,accentRgb:i.violet300.rgb},{id:"testing",label:x.testing,icon:Ge,accent:i.lime500.hex,accentRgb:i.lime500.rgb},{id:"docs",label:x.docs,icon:De,accent:i.blue400.hex,accentRgb:i.blue400.rgb},{id:"history",label:x.history,icon:vt,accent:i.emerald400.hex,accentRgb:i.emerald400.rgb},{id:"insights",label:x.insights,icon:nt,accent:i.teal500.hex,accentRgb:i.teal500.rgb},{id:"conversations",label:x.conversations,icon:et,accent:i.pink500.hex,accentRgb:i.pink500.rgb},{id:"learning",label:"Learning",icon:qe,accent:i.emerald400.hex,accentRgb:i.emerald400.rgb},{id:"evals",label:x.evals,icon:st,accent:i.yellow500.hex,accentRgb:i.yellow500.rgb},{id:"settings",label:x.settings,icon:rt,accent:i.orange500.hex,accentRgb:i.orange500.rgb}],Rt=new Set(["overview","enterprise","hud","plans","workflows","calendar","harnesses","health","conversations","learning","frames","evals"]);function jt(e){return e?F.filter(r=>Rt.has(r.id)):F}var Ot=["off","window","screen"];function ae(e){return e==="off"?"window":e==="window"?"screen":"off"}function Nt(e){return e==="screen"?"window":"off"}function re(e){return e==="off"?"Maximize this tab":e==="window"?"Fullscreen this tab (whole screen)":"Exit fullscreen"}var G=new Set(["overview","enterprise","hud","workflows","harnesses","learning"]),Lt=ct;function Ct(e){const r=[],n=[];for(const s of e)(G.has(s.id)?r:n).push(s);return{primary:r,secondary:n}}var Mt=3,ne=()=>M("adv.recentSecondaryTabs");function It(e){if(!e)return[];try{const r=JSON.parse(e);return Array.isArray(r)?r.filter(n=>typeof n=="string"&&W.includes(n)&&!G.has(n)):[]}catch{return[]}}function Dt(e,r){return[r,...e.filter(n=>n!==r)].slice(0,Mt)}function Pt(e,r,n){const s=r-n;return{left:e>1,right:e<s-1}}var K=(0,p.createContext)({allMode:!0,scopeMode:"all",slug:null,hive:"",harnessSlugs:null,ready:!1});function zt(e,r,n){return e==="all"?null:r?e==="self"?[r]:it(r,n.map(s=>({slug:s.slug,parent_slug:s.parent_slug??(s.hive_slug&&s.hive_slug!==s.slug?s.hive_slug:null)}))):[]}function Ia(){return(0,p.useContext)(K)}function le(){const[e,r]=_("slug",Q),[,n]=_("harness",Q),[s,l]=_("scope",H([...lt]).withDefault("expanded")),{data:c,error:h,invalidate:v}=oe({queryName:"harnessProjects.lite",args:{includeHiveHomes:!0},staleTime:6e4}),o=c??[],u=h?String(h.message??h):null,f=(0,p.useRef)(!1);(0,p.useEffect)(()=>{if(f.current||o.length===0)return;f.current=!0;let T=!1;const I=typeof window<"u"?window.localStorage.getItem(M("harness.activeProject")):null,R=wt({projectSlugs:o.map(D=>D.slug),urlSlug:e,urlScope:s,persisted:I});return(async()=>(R.setSlug&&await r(R.setSlug),!T&&R.setScope&&await l(R.setScope)))(),()=>{T=!0}},[o.length]);const b=s==="all",g=b?null:e,y=g?o.find(T=>T.slug===g):void 0,O=y?.harness_kind==="hive";return{activeSlug:e,setActiveSlug:r,setActiveHarness:n,scopeMode:s,setScopeMode:l,projects:o,projectLoadError:u,refreshProjects:v,allMode:b,singleSlug:g,activeProject:y,activeSlugIsHive:O,advScope:(0,p.useMemo)(()=>({allMode:b,scopeMode:s,slug:g,hive:g?O?g:y?.hive_slug||g:"",harnessSlugs:zt(s,g,o),ready:b||o.length>0||!!u}),[b,s,g,O,y?.hive_slug,o,u])}}function ce({allMode:e,activeSlug:r,activeIsHive:n,refreshProjects:s}){const[l,c]=_("create",C.withDefault(!1)),[h,v]=_("share",C.withDefault(!1));return(0,t.jsxs)(t.Fragment,{children:[(0,t.jsx)(Xe,{open:l,onOpenChange:o=>{c(o)},hiveScope:n?r:null,onCreated:(o,u)=>{s(),!(u?.hive&&u.hive===r)&&typeof window<"u"&&window.localStorage.setItem(M("harness.activeProject"),o)}}),h&&!e&&r&&n&&(0,t.jsx)(je,{open:h,onOpenChange:o=>{o||(v(!1),s())},title:`Share ${r}`,contentStyle:{width:"min(480px, 96vw)",background:"var(--bg-popover, #0d1829)",border:"1px solid var(--border)",borderRadius:10,padding:24,color:"var(--fg, #e8e8ea)"},children:(0,t.jsx)(Je,{potSlug:r})})]})}function de({projects:e,activeSlug:r,allMode:n,setScopeMode:s,setActiveSlug:l,setActiveHarness:c}){const[,h]=_("create",C.withDefault(!1)),v={enableOnFormTags:["INPUT","TEXTAREA","SELECT"]},o=async u=>{if(e.length===0)return;const f=e.map(y=>y.slug),b=r?f.indexOf(r):-1,g=b===-1?u===1?f[0]:f[f.length-1]:f[(b+u+f.length)%f.length];!g||!n&&g===r||(n&&await s("expanded"),await l(g),await c(null),typeof window<"u"&&window.localStorage.setItem(M("harness.activeProject"),g))};w("harness.prev",()=>{o(-1)},v),w("harness.next",()=>{o(1)},v),w("harness.create",()=>{h(!0)})}function Da({children:e}){const r=le(),{advScope:n,allMode:s,activeSlug:l,activeSlugIsHive:c,refreshProjects:h}=r;return de(r),(0,t.jsxs)(K.Provider,{value:n,children:[e,(0,t.jsx)(ce,{allMode:s,activeSlug:l,activeIsHive:c,refreshProjects:h})]})}function Pa({children:e}){const r=Le(),n=Ce(Ne()??"",Oe().toString()),[s,l]=_("tab",H([...W]).withDefault("overview")),c=At(s,n);(0,p.useEffect)(()=>{c!==s&&l(c)},[s,c,l]);const h=(0,p.useRef)(null);(0,p.useEffect)(()=>{const a=h.current;if(!a)return;const d=a.querySelector(`.pc-advshell__tab--${c}`);if(!d)return;const S=a.getBoundingClientRect(),J=d.getBoundingClientRect(),X=8,_e=J.left<S.left+X,ye=J.right>S.right-X;if(!(!_e&&!ye))try{d.scrollIntoView({behavior:"smooth",block:"nearest",inline:"nearest"})}catch{}},[c]);const[v,o]=(0,p.useState)({left:!1,right:!1}),u=(0,p.useCallback)(()=>{const a=h.current;a&&o(Pt(a.scrollLeft,a.scrollWidth,a.clientWidth))},[]);(0,p.useEffect)(()=>{const a=h.current;if(!a)return;u(),a.addEventListener("scroll",u,{passive:!0});const d=typeof ResizeObserver<"u"?new ResizeObserver(()=>u()):null;d?.observe(a);const S=typeof MutationObserver<"u"?new MutationObserver(()=>u()):null;return S?.observe(a,{childList:!0}),window.addEventListener("resize",u),()=>{a.removeEventListener("scroll",u),d?.disconnect(),S?.disconnect(),window.removeEventListener("resize",u)}},[u]);const f=(0,p.useCallback)(a=>{const d=h.current;d&&d.scrollBy({left:a*Math.max(140,d.clientWidth*.7),behavior:"smooth"})},[]),{activeSlug:b,setActiveSlug:g,setActiveHarness:y,scopeMode:O,setScopeMode:T,projects:I,projectLoadError:R,refreshProjects:D,allMode:N,activeSlugIsHive:he,advScope:pe}=le(),[m,A]=_("max",H([...Ot]).withDefault("off")),j=(0,p.useRef)(m);j.current=m,(0,p.useEffect)(()=>{if(typeof document>"u")return;const{body:a}=document;return m==="off"?a.removeAttribute("data-adv-max"):a.setAttribute("data-adv-max",m),()=>a.removeAttribute("data-adv-max")},[m]);const L=(0,p.useCallback)(async a=>{let d=a;if(typeof document<"u")try{d==="screen"?document.fullscreenElement||await document.documentElement.requestFullscreen?.():document.fullscreenElement&&await document.exitFullscreen?.()}catch{d==="screen"&&(d="window")}await A(d)},[A]);(0,p.useEffect)(()=>()=>{typeof document>"u"||j.current==="screen"&&document.fullscreenElement&&document.exitFullscreen?.().catch(()=>{})},[]),(0,p.useEffect)(()=>{if(typeof document>"u")return;const a=()=>{!document.fullscreenElement&&j.current==="screen"&&A("window")};return document.addEventListener("fullscreenchange",a),()=>document.removeEventListener("fullscreenchange",a)},[A]);const $=(0,p.useRef)(!1);(0,p.useEffect)(()=>{$.current||typeof document>"u"||($.current=!0,m==="screen"&&!document.fullscreenElement&&A("window"))},[m,A]),(0,p.useEffect)(()=>{if(m==="off"||typeof document>"u")return;const a=d=>{d.key!=="Escape"||d.defaultPrevented||document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], [role="combobox"][aria-expanded="true"]')||(d.preventDefault(),L(Nt(j.current)))};return document.addEventListener("keydown",a),()=>document.removeEventListener("keydown",a)},[m,L]);const ue=Z(ee.SYSTEM_HEALTH_TAB),fe=Z(ee.REPORTS_LIBRARY),P=jt(N).filter(a=>a.id!=="health"||ue),q=F.find(a=>a.id===c),E=Et(N&&q&&!P.some(a=>a.id===c)?[...P,q]:P,n),be=!n||V.has(c),{primary:ge,secondary:z}=Ct(E),me=z.some(a=>a.id===c),[ve,B]=(0,p.useState)(!1),[xe,we]=(0,p.useState)(()=>typeof window>"u"?[]:It(window.localStorage.getItem(ne())));(0,p.useEffect)(()=>{n||G.has(c)||we(a=>{if(a[0]===c)return a;const d=Dt(a,c);return typeof window<"u"&&window.localStorage.setItem(ne(),JSON.stringify(d)),d})},[c,n]);const U={enableOnFormTags:["INPUT","TEXTAREA","SELECT"]},Y=a=>{const d=E[(E.findIndex(S=>S.id===c)+a+E.length)%E.length];d&&d.id!==c&&l(d.id)};return w("goto.prevTab",()=>Y(-1),U),w("goto.nextTab",()=>Y(1),U),de({projects:I,activeSlug:b,allMode:N,setScopeMode:T,setActiveSlug:g,setActiveHarness:y}),w("goto.inbox",()=>{l("conversations")}),w("goto.brainstorm",()=>{l("brainstorm")}),w("goto.insights",()=>{l("insights")}),w("view.fullscreen",()=>{L(ae(j.current))}),(0,t.jsxs)("div",{className:"pc-advshell","data-testid":"operator-shell",children:[be&&(0,t.jsx)("header",{className:"pc-advshell__header",children:(0,t.jsxs)(ft,{value:c,onValueChange:a=>{l(a)},className:"pc-advshell__tabs","data-of-left":v.left?"":void 0,"data-of-right":v.right?"":void 0,children:[(0,t.jsx)("button",{type:"button",className:"pc-advshell__tabnav pc-advshell__tabnav--left","aria-label":"Scroll tabs left to hidden tabs",tabIndex:-1,onClick:()=>f(-1),children:"‹"}),(0,t.jsx)(ut,{ref:h,className:"pc-advshell__tablist","aria-label":"Adv sections",children:ge.map(a=>{const d=a.icon;return(0,t.jsxs)(pt,{value:a.id,className:`pc-advshell__tab pc-advshell__tab--${a.id}`,style:{"--h-main-tab-accent":a.accent,"--h-main-tab-accent-rgb":a.accentRgb},children:[(0,t.jsx)(d,{size:13,"aria-hidden":!0}),(0,t.jsx)("span",{className:"pc-advshell__tab-label",children:a.label.toLowerCase()})]},a.id)})}),z.length>0&&(0,t.jsx)(ie,{open:ve,onOpenChange:B,trigger:(0,t.jsxs)("button",{type:"button",className:`pc-advshell__more-trigger${me?" pc-advshell__more-trigger--active":""}`,"aria-label":"More sections",children:[(0,t.jsx)("span",{children:"More"}),(0,t.jsx)(We,{size:12,"aria-hidden":!0})]}),ariaLabel:"More sections",side:"bottom",align:"start",autoFocusOnOpen:!0,contentClassName:"pc-advshell__more-panel",children:(0,t.jsx)(Bt,{groups:Lt,tabs:z,recentIds:xe,activeTab:c,onOpenReports:fe?()=>{B(!1),r.push("/reports")}:void 0,onSelect:a=>{l(a),B(!1)}})}),(0,t.jsxs)("div",{className:"pc-advshell__header-status",children:[(0,t.jsx)(ht,{}),(0,t.jsx)(St,{})]}),(0,t.jsx)("div",{className:"pc-advshell__tools",children:(0,t.jsx)(ot,{label:`${re(m)} — Ctrl/⌘+Shift+Enter${m==="off"?"":" · Esc steps back"}`,side:"bottom",align:"end",children:(0,t.jsx)("button",{type:"button",className:"pc-advshell__maxbtn","data-testid":"adv-fullscreen-toggle","data-level":m,"aria-label":re(m),"aria-pressed":m!=="off",onClick:()=>{L(ae(m))},children:(0,t.jsx)("span",{className:"pc-advshell__maxbtn-inner",children:m==="off"?(0,t.jsx)(Ze,{size:13,"aria-hidden":!0}):(0,t.jsx)(tt,{size:13,"aria-hidden":!0})})})})}),(0,t.jsx)("button",{type:"button",className:"pc-advshell__tabnav pc-advshell__tabnav--right","aria-label":"Scroll tabs right to hidden tabs",tabIndex:-1,onClick:()=>f(1),children:"›"}),E.map(a=>(0,t.jsx)(bt,{value:a.id,forceMount:!0,style:{display:"none"}},a.id))]})}),(0,t.jsx)(ce,{allMode:N,activeSlug:b,activeIsHive:he,refreshProjects:D}),(0,t.jsx)("div",{className:"pc-advshell__body",children:(0,t.jsx)(K.Provider,{value:pe,children:e})}),(0,t.jsx)("style",{children:`
        .pc-advshell {
          display: flex;
          flex-direction: column;
          /* Viewport-bounded (NOT min-height) so the shell never grows past
             the window. This makes the per-tab content panes the real
             scrollers — without it the whole shell grows and the WINDOW
             scrolls, which defeats every inner sticky/overflow pane (e.g.
             the Plans preview pane never sticks). */
          height: calc(100vh - 56px);
          min-height: 0;
          background:
            radial-gradient(circle at top left, color-mix(in oklab, var(--accent, #38bdf8), transparent 91%), transparent 30%),
            linear-gradient(180deg, var(--bg, #07101d), var(--bg-deepest, #02060c));
        }
        .pc-advshell__header {
          display: flex;
          flex-direction: column;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
          background: var(--bg-2, rgba(255, 255, 255, 0.045));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.025);
        }
        /* The pot cluster's rules (selector · sub-pots · New/Share) moved to
           adv-pot-bar.css, and AdvNowRunning's (--start/--stop/--waiting, the
           status bar) to the shared adv-header-pills.css, when the cluster left
           this header for the tab bodies (owner ask 2026-07-27). A stylesheet that
           only applies "while AdvShell happens to be mounted" is exactly the
           fragility adv-header-pills.css was extracted to fix
           (quick-panel-status-pills-2026-07-13 D-001) — so the rules travel with
           the components that own them, not with this shell. */
        @keyframes pc-advshell-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        /* The strip is now the FIRST row of the header, so it carries the top
           padding the removed title row used to provide. */
        .pc-advshell__tabs { position: relative; min-width: 0; display: flex; align-items: flex-end; padding: 6px 12px 0; }
        .pc-advshell__tab-label { display: inline; }
        /* The workspace status pills, sitting immediately right of More (owner ask
           2026-08-01). NOTE: this whole block is a JS template literal, so it must
           contain NO backticks — one in a comment ends the literal and the file
           fails to parse (hit while writing this rule; the same trap reds
           operator-core when a SQL comment quotes an identifier).

           align-items:center + the bottom margin lift the pills off the strip's
           flex-end baseline so they read as centred against the 34px tabs rather
           than hanging from their bottom edge.

           The narrow-window contract, and why it needs the two overrides below.
           This strip is NOT the window width — the left sidebar takes most of it
           (measured live: a 1280px window left the strip 439px). Tabs + More
           already fill that on their own, which is what the overflow chevrons
           exist for. Dropping ~420px of pills in beside them therefore overflows
           by default, and the pills lose their own base rule to boot:
           .pc-advshell__action sets flex-shrink: 0 (adv-header-pills.css — right
           for a pill in a roomy bar), so a shrinking wrapper does NOT shrink
           them; they spill straight out of it and off the window edge. Measured
           before the fix: the agents pill ran to x=1455 in a 1280px window.

           So: the wrapper shrinks (flex: 0 1 auto + min-width: 0) AND clips
           (overflow: hidden), and inside it the pills are allowed to shrink and
           ellipsize. The leading "N agents running" survives; the tail (thinking
           count, fleet dots) is what degrades — correct, since the head is the
           number the bar exists to show. Tabs keep their space: they are
           navigation, the pills are only a readout.

           The right-hand margin applies only while the strip is actually
           overflowing: .pc-advshell__tabnav--right is absolutely positioned at
           right: 12px and is displayed only under [data-of-right] — so without
           this the chevron would land on top of the last pill exactly when the
           window is tight enough for them to collide. */
        .pc-advshell__header-status {
          display: flex;
          align-items: center;
          gap: 6px;
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          margin-left: 8px;
          margin-bottom: 6px;
        }
        .pc-advshell__header-status .pc-advshell__action {
          flex-shrink: 1;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          display: inline-block;
          line-height: 18px;
        }
        /* The right-hand tool cluster (currently just the fullscreen toggle). It is
           the LAST thing in the strip, so it — not the pills — is what the overflow
           chevron would land on top of; the 26px clearance moved here with it. */
        .pc-advshell__tools {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
          margin-left: auto;
          margin-bottom: 6px;
          padding-left: 8px;
        }
        .pc-advshell__tabs[data-of-right] .pc-advshell__tools { margin-right: 26px; }
        /* display:block, with the centring on the inner span — WebKitGTK (the
           Tauri webview) ignores flex/grid on a button element itself, so the
           icon would sit off-centre in the shipped desktop app and nowhere else
           (WI-5581, enforced by lint:design-primitives). */
        .pc-advshell__maxbtn {
          display: block;
          width: 26px;
          height: 26px;
          min-height: 26px;
          padding: 0;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.15));
          border-radius: 7px;
          background: transparent;
          color: var(--fg-mute, #8fa9be);
          cursor: pointer;
          transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
        }
        .pc-advshell__maxbtn-inner {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .pc-advshell__maxbtn:hover,
        .pc-advshell__maxbtn:focus-visible {
          color: var(--fg, #e7f7ff);
          border-color: color-mix(in srgb, var(--accent, #38bdf8), transparent 55%);
          background: color-mix(in srgb, var(--accent, #38bdf8), transparent 90%);
        }
        /* Maximized/fullscreen reads as ON, so the control that got you here stays
           findable against a full-bleed tab body. */
        .pc-advshell__maxbtn[aria-pressed='true'] {
          color: var(--accent, #38bdf8);
          border-color: color-mix(in srgb, var(--accent, #38bdf8), transparent 45%);
          background: color-mix(in srgb, var(--accent, #38bdf8), transparent 88%);
        }

        /* ── Tab fullscreen (owner ask 2026-08-31) ───────────────────────────
           Both levels ('window' and 'screen') use the SAME layout: the shell
           becomes a viewport-filling overlay. 'screen' differs only in that the
           document is additionally in real OS fullscreen, which is the window
           manager's business, not CSS's.

           z-index 1350 is chosen from both sides, not picked for headroom:
             ABOVE the app chrome this is meant to cover — PresenceRail (900),
             LeftSidebar (1290), the sticky ChromeShell header (1300);
             BELOW every layer a tab can portal to <body> — BlockNote's editor
             menus (1400), the voice hint (1410), the maximal-HUD oracle dock
             (1450) and the modal band (1500+). Going higher would hide a dialog
             opened from inside the maximized tab behind it.

           Top is the env-bar height, not 0: EnvSwitcherBar is fixed at z-index
           2147483640 by design (it is the deliberate escape hatch if a build
           white-screens) and publishes its measured height as --pc-env-bar-h,
           which is exactly how .pc-header already sits below it. */
        body[data-adv-max] .pc-advshell {
          position: fixed;
          top: var(--pc-env-bar-h, 0px);
          left: 0;
          right: 0;
          bottom: 0;
          height: auto;
          z-index: 1350;
        }
        /* NOTE: no backticks anywhere in this block — it is a JS template literal
           and one in a comment ends the literal (the warning on the pills rule
           above; hit again writing this one).

           main[data-route-transition-page] carries will-change: transform, which
           makes it a CONTAINING BLOCK for position:fixed descendants — without this
           the overlay above would size to <main> (the area the chrome already left
           over) instead of the viewport, i.e. it would "maximize" into exactly the
           box it is supposed to escape. Route transitions do not run while a tab is
           maximized, so dropping the hint costs nothing. */
        body[data-adv-max] [data-route-transition-page='true'] {
          will-change: auto;
          transform: none;
          filter: none;
        }
        .pc-advshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          min-width: 0;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          padding: 0;
        }
        .pc-advshell__tablist::-webkit-scrollbar {
          display: none;
        }
        /* Tab-strip overflow affordance (owner ask 2026-06-15 #1). When tabs are
           clipped, fade the clipped edge (a background-independent CSS mask, with
           the -webkit- prefix for the WebKitGTK desktop) so it reads "there are
           more tabs"; the chevron buttons below give a click-to-scroll. */
        .pc-advshell__tabs[data-of-left][data-of-right] .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
        }
        .pc-advshell__tabs[data-of-left]:not([data-of-right]) .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 26px);
          mask-image: linear-gradient(90deg, transparent 0, #000 26px);
        }
        .pc-advshell__tabs:not([data-of-left])[data-of-right] .pc-advshell__tablist {
          -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 26px), transparent 100%);
          mask-image: linear-gradient(90deg, #000 calc(100% - 26px), transparent 100%);
        }
        .pc-advshell__tabnav {
          position: absolute;
          top: 0;
          bottom: 1px;
          z-index: 3;
          display: none;
          align-items: center;
          width: 26px;
          padding: 0;
          border: none;
          background: none;
          color: var(--fg-dim, #b9d4e8);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          transition: color var(--dur-fast, 120ms) var(--ease-out, ease);
        }
        .pc-advshell__tabnav:hover { color: var(--fg, #e7f7ff); }
        .pc-advshell__tabnav--left { left: 12px; justify-content: flex-start; }
        .pc-advshell__tabnav--right { right: 12px; justify-content: flex-end; }
        .pc-advshell__tabs[data-of-left] .pc-advshell__tabnav--left { display: inline-flex; }
        .pc-advshell__tabs[data-of-right] .pc-advshell__tabnav--right { display: inline-flex; }
        .pc-advshell__tab {
          position: relative;
          flex: 0 0 auto;
          scroll-snap-align: start;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 34px;
          margin-bottom: -1px;
          padding: 9px 14px 10px;
          border: 1px solid transparent;
          border-bottom: 1px solid transparent;
          border-radius: 10px 10px 0 0;
          background:
            radial-gradient(circle at 18% 0%, rgba(var(--h-main-tab-accent-rgb), 0.12), transparent 72%),
            linear-gradient(
              180deg,
              rgba(var(--h-main-tab-accent-rgb), 0.080),
              color-mix(in srgb, var(--bg-deeper, #030a14), transparent 2%)
            );
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.28);
          color: color-mix(in oklab, var(--fg-dim, #b9d4e8), var(--h-main-tab-accent) 18%);
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0;
          text-transform: uppercase;
          cursor: pointer;
          transition: color var(--dur-fast, 120ms) var(--ease-out, ease), border-color var(--dur-fast, 120ms) var(--ease-out, ease), background-color var(--dur-fast, 120ms) var(--ease-out, ease);
        }
        .pc-advshell__tab:hover {
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__tab:focus-visible {
          color: var(--fg, #e7f7ff);
          outline: 1px solid color-mix(in oklab, var(--accent, #38bdf8), white 16%);
          outline-offset: -2px;
        }
        .pc-advshell__tab[aria-selected='true'],
        .pc-advshell__tab[data-state='active'] {
          color: var(--fg, #e7f7ff);
          background: rgba(var(--h-main-tab-accent-rgb), 0.22);
          border-color: rgba(var(--h-main-tab-accent-rgb), 0.68);
          border-bottom-color: color-mix(in oklab, var(--bg-2, rgba(255, 255, 255, 0.045)), white 3%);
          box-shadow: 0 -8px 22px rgba(0, 0, 0, 0.16);
        }
        .pc-advshell__tab[aria-selected='true']::after,
        .pc-advshell__tab[data-state='active']::after {
          content: "";
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 2px;
          height: 2px;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--h-main-tab-accent), color-mix(in oklab, var(--h-main-tab-accent), white 28%));
          box-shadow: 0 0 14px color-mix(in oklab, var(--h-main-tab-accent), transparent 54%);
        }
        /* ── "More" menu (D-001): trigger button + searchable/grouped popover ── */
        .pc-advshell__more-trigger {
          position: relative;
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 34px;
          margin-bottom: -1px;
          margin-left: 2px;
          padding: 9px 12px 10px;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28));
          border-radius: 10px 10px 0 0;
          background: linear-gradient(
            180deg,
            color-mix(in srgb, var(--accent), transparent 94%),
            color-mix(in srgb, var(--bg-deeper, #030a14), transparent 2%)
          );
          color: var(--fg-dim, #b9d4e8);
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0;
          text-transform: uppercase;
          cursor: pointer;
        }
        .pc-advshell__more-trigger:hover,
        .pc-advshell__more-trigger:focus-visible {
          color: var(--fg, #e7f7ff);
          outline: none;
        }
        .pc-advshell__more-trigger--active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in srgb, var(--accent), transparent 82%);
          border-color: var(--border-strong, rgba(125, 211, 252, 0.55));
        }
        .pc-advshell__more-panel {
          width: min(280px, 92vw);
          max-height: min(420px, 70vh);
          display: flex;
          border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
          border-radius: 10px;
          background: var(--bg-popover, #0d1829);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
          overflow: hidden;
        }
        .pc-advshell__more-cmd { display: flex; flex-direction: column; width: 100%; min-height: 0; }
        .pc-advshell__more-input {
          margin: 8px;
          padding: 7px 10px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
          border-radius: 8px;
          background: var(--bg, #07101d);
          color: var(--fg, #e7f7ff);
          font-size: 12.5px;
          outline: none;
        }
        .pc-advshell__more-input:focus { border-color: var(--accent, #38bdf8); }
        .pc-advshell__more-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 6px; }
        .pc-advshell__more-empty {
          padding: 10px 12px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 12px;
        }
        .pc-advshell__more-group [cmdk-group-heading] {
          padding: 8px 8px 4px;
          color: var(--fg-mute, #7f9bb4);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .pc-advshell__more-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 8px;
          border-radius: 7px;
          color: var(--fg-dim, #b9d4e8);
          font-size: 12.5px;
          font-weight: 550;
          cursor: pointer;
        }
        .pc-advshell__more-item svg:first-child { color: var(--h-main-tab-accent); }
        .pc-advshell__more-item[data-selected='true'] {
          background: color-mix(in srgb, var(--accent), transparent 86%);
          color: var(--fg, #e7f7ff);
        }
        .pc-advshell__more-item[data-active] { color: var(--fg, #e7f7ff); font-weight: 650; }
        .pc-advshell__more-item-check { margin-left: auto; color: var(--accent, #38bdf8); }

        /* Fallback scroller: tabs that lay out their own internal overflow
           panes (Plans, Sessions) scroll there; tabs that don't (e.g.
           Insights) scroll here instead of growing the shell + window. */
        .pc-advshell__body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
        /* The tab body, BELOW the pot bar (flex:none chrome inside
           .pc-advshell__body). It carries the same fallback-scroller contract the
           body has, because with a sibling row above it the body's own height is
           no longer the tab's height: a tab that manages its own overflow needs a
           definite height to lay out against (.hud's height:100% resolves here),
           and a tab that doesn't scrolls here rather than being clipped.
           NOTE: no backticks in this <style> template literal — one terminates it. */
        .pc-advshell__tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }

        /* Flat in-page buttons. Action buttons / pills inside the page body
           get NO embossed bevel, raised drop-shadow, glow, or hover-lift —
           those "3D" treatments are hard to read. The large top tab strip
           lives in .pc-advshell__header (page-level nav, a different
           category) and is intentionally NOT affected. Focus-visible rings
           are preserved for keyboard a11y. See /internal/docs/design#buttons.

           EI-18772095428507037 — the [data-shadow-ok] opt-out. This reset is
           an !important rule on a DESCENDANT selector, so it silently beat every
           box-shadow any component inside the shell body declared, no matter
           what that component's own stylesheet said. It failed invisibly:
           no console warning, the losing rule sits right there in the CSS file
           and in devtools' stylesheet list, and unit tests cannot read computed
           style — so an author reasonably concluded their shadow worked. It was
           only found by reading computed style in a live shell, where
           .hud__tab--on's 1px board-bridge shadow computed to none.

           The blanket ban was too broad because it cannot tell a DECORATIVE
           bevel (what it exists to kill) from a STRUCTURAL hairline (a tab
           bridging its panel's border). Opting in with data-shadow-ok is that
           distinction, made explicit at the call site and greppable. */
        .pc-advshell__body :is(button, [role="button"]):not(:focus-visible):not([data-shadow-ok]) {
          box-shadow: none !important;
        }
        .pc-advshell__body :is(button, [role="button"]):hover,
        .pc-advshell__body :is(button, [role="button"]):active {
          transform: none !important;
        }
      `})]})}function Bt({groups:e,tabs:r,recentIds:n,activeTab:s,onSelect:l,onOpenReports:c}){const h=(0,p.useMemo)(()=>new Map(r.map(o=>[o.id,o])),[r]),v=n.map(o=>h.get(o)).filter(o=>!!o);return(0,t.jsxs)(k,{label:"More sections",loop:!0,shouldFilter:!0,className:"pc-advshell__more-cmd",children:[(0,t.jsx)(k.Input,{autoFocus:!0,className:"pc-advshell__more-input",placeholder:"Find a section…","aria-label":"Filter sections"}),(0,t.jsxs)(k.List,{className:"pc-advshell__more-list",children:[(0,t.jsx)(k.Empty,{className:"pc-advshell__more-empty",children:"No matching section"}),v.length>0&&(0,t.jsx)(k.Group,{heading:"Recent",className:"pc-advshell__more-group",children:v.map(o=>(0,t.jsx)(se,{tab:o,active:o.id===s,onSelect:l},`recent-${o.id}`))}),e.map(o=>{const u=o.tabIds.map(b=>h.get(b)).filter(b=>!!b),f=o.id==="insights"&&!!c;return u.length===0&&!f?null:(0,t.jsxs)(k.Group,{heading:o.label,className:"pc-advshell__more-group",children:[u.map(b=>(0,t.jsx)(se,{tab:b,active:b.id===s,onSelect:l},b.id)),f&&(0,t.jsxs)(k.Item,{value:"Reports",onSelect:c,className:"pc-advshell__more-item",children:[(0,t.jsx)(Ve,{size:13,"aria-hidden":!0}),(0,t.jsx)("span",{children:"Reports"})]})]},o.id)})]})]})}function se({tab:e,active:r,onSelect:n}){const s=e.icon;return(0,t.jsxs)(k.Item,{value:e.label,onSelect:()=>n(e.id),className:"pc-advshell__more-item","data-active":r?"":void 0,style:{"--h-main-tab-accent":e.accent},children:[(0,t.jsx)(s,{size:13,"aria-hidden":!0}),(0,t.jsx)("span",{children:e.label}),r&&(0,t.jsx)(Fe,{size:12,"aria-hidden":!0,className:"pc-advshell__more-item-check"})]})}function za(e,r,n="Pots",s="Workspace"){if(e.length===0)return[{value:"__loading",label:r?`Failed to load ${n}`:`Loading ${n}…`,disabled:!0}];const l=[];for(const c of gt(e)){const h=c.root,v=c.members.filter(f=>f.slug!==h.slug),o=h.harness_kind==="hive"||h.slug.endsWith("-hive"),u=o?dt(h.slug):h.slug;l.push({value:h.slug,label:u});for(const f of v)o&&f.slug===u||l.push({value:f.slug,label:`  ↳ ${f.slug}`})}return[{value:xt,label:`All ${n}`},{kind:"group",label:s,options:l}]}export{Ia as C,xt as D,jt as E,Pt as S,de as T,Et as _,Da as a,zt as b,V as c,Rt as d,re as f,At as g,It as h,ce as i,G as l,ae as m,F as n,Pa as o,za as p,W as r,Tt as s,Ot as t,Lt as u,Nt as v,le as w,Ct as x,Dt as y};
