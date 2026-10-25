import{o as we}from"./chunk-a1a4177d.js";import{t as ye}from"./react-ea1d8b8b.js";import{t as je}from"./jsx-runtime-660d4162.js";import{a as ne,c as Ne,f as Se,h as ae,l as re,n as oe,p as Ie,r as Ce,s as H,t as ie,u as le}from"./logic-90065575.js";var a=we(ye(),1),ce={queen:"☕",overwatch:"🫖",bee:"🍵",sentinel:"🥤",planner:"📋",su:"🛠",mug:"☕",kettle:"🫖",cup:"🍵",papercup:"🥤"},$e=[{kind:"mug",term:"brain"},{kind:"kettle",term:"overwatch"},{kind:"cup",term:"contributor"},{kind:"papercup",term:"operator"},{kind:"planner",term:null,literal:"planner"},{kind:"su",term:null,literal:"su"}];function V(s){return ce[(s.agentPaneKind??s.role??"").toLowerCase()]??"·"}var e=je();function Te({agent:s,color:o,pinned:i,nowMs:c,labels:f,chrome:x,onInspect:v}){const{ThinkingDot:l}=x,N=ne(s,f.agentLabel);return(0,e.jsxs)("div",{className:"pc-agents-roster__detail","data-testid":"agent-detail",children:[(0,e.jsxs)("div",{className:"pc-agents-roster__detail-head",style:o?{color:o}:void 0,children:[V(s)," ",(0,e.jsx)("strong",{children:N}),s.fleetSlug?(0,e.jsxs)("span",{className:"pc-agents-roster__detail-fleet",children:[" · ",s.fleetSlug]}):null,(0,e.jsxs)("span",{className:"pc-agents-roster__detail-live",title:oe(s,c),children:[" · ",ie(s,c),s.loopArmed?" (loop armed)":""]}),le(s)?(0,e.jsxs)("span",{className:"pc-agents-roster__detail-thinking",style:{marginLeft:6,display:"inline-flex",alignItems:"center",gap:4,color:"#6aa84f"},children:[(0,e.jsx)(l,{size:6})," thinking"]}):null,i?(0,e.jsx)("span",{className:"pc-agents-roster__detail-pin",children:" · pinned"}):null]}),(0,e.jsxs)("dl",{className:"pc-agents-roster__detail-grid",children:[(0,e.jsx)("dt",{children:"Agent"}),(0,e.jsxs)("dd",{children:[s.agent??(f.roleLabel(s.role)||"—")," · ",(0,e.jsx)("code",{children:ae(s.ownerId)})]}),(0,e.jsx)("dt",{children:"Plan"}),(0,e.jsx)("dd",{children:s.currentPlanSlug??"—"}),(0,e.jsx)("dt",{children:"Work item"}),(0,e.jsx)("dd",{children:s.feature??"—"}),(0,e.jsx)("dt",{children:"Doing"}),(0,e.jsx)("dd",{children:s.intent||"(no declared intent)"})]}),v&&re(s)?(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__inspect","data-testid":"agent-inspect-btn",onClick:()=>v(s),children:"▶ Live thinking"}):s.thinkingResolvable===!1?(0,e.jsx)("div",{className:"pc-agents-roster__nothinking","data-testid":"agent-no-thinking-note",children:"Live thinking unavailable — no transcript to stream (this session has ended or its transcript was rotated away since it last took a turn)."}):v?(0,e.jsxs)("div",{className:"pc-agents-roster__nothinking","data-testid":"agent-no-thinking-note",children:["Live thinking unavailable — this ",s.agent??"session"," process recorded no transcript handle (no session row, run-log, or thread id) to stream from."]}):null]})}var de={Tooltip:({label:s,children:o})=>(0,e.jsx)("span",{title:typeof s=="string"?s:void 0,children:o}),LivenessDot:({liveness:s,size:o=8,title:i})=>(0,e.jsx)("span",{role:"img","aria-label":`${s} agent`,"data-liveness":s,title:i,className:"pc-agents-roster__dot",style:{display:"inline-block",width:o,height:o,borderRadius:"50%"}}),ThinkingDot:({size:s=7,title:o="thinking"})=>(0,e.jsx)("span",{role:"img","aria-label":o,title:o,"data-liveness":"thinking",className:"pc-agents-roster__dot pc-agents-roster__dot--thinking",style:{display:"inline-block",width:s,height:s,borderRadius:"50%"}})},pe={term:(s,o)=>o?.lower?s.toLowerCase():s,agentLabel:s=>s,roleLabel:s=>s?.trim()??""};function Pe({agents:s,nowMs:o,focusOwner:i=null,chrome:c=de,labels:f=pe,machineTab:x=null,onMachineTabChange:v,bulk:l=null,onInspect:N,onRowActivate:D,children:O}){const{Tooltip:S,LivenessDot:B,ThinkingDot:W}=c,k=t=>ne(t,f.agentLabel),L=!!l,[I,R]=(0,a.useState)(null),[$,K]=(0,a.useState)(null),T=(0,a.useRef)(null);(0,a.useEffect)(()=>{if(!i){T.current=null;return}if(T.current===i||!s.some(n=>n.ownerId===i))return;T.current=i,R(i),K(i);const t=window.setTimeout(()=>{document.querySelector(`[data-testid="agent-row-${i}"]`)?.scrollIntoView({block:"nearest"})},60);return()=>window.clearTimeout(t)},[i,s]);const _=(0,a.useMemo)(()=>Ie(s),[s]),z=_.length>1,w=z?x&&_.some(t=>t.key===x)?x:_[0].key:null,g=(0,a.useMemo)(()=>w?s.filter(t=>Se(t)===w):s,[s,w]),y=(0,a.useMemo)(()=>Ne(g),[g]),P=g.length,r=(0,a.useRef)(null),p=(0,a.useMemo)(()=>{const t=n=>{if(!n)return null;for(const d of y){const A=d.agents.find(ke=>ke.ownerId===n);if(A)return{agent:A,color:d.color}}return null};return t(I)??t($)??t(r.current)??(g[0]?t(g[0].ownerId):null)},[y,g,I,$]);(0,a.useEffect)(()=>{p&&(r.current=p.agent.ownerId)},[p]);const[u,b]=(0,a.useState)(()=>new Set),[j,Y]=(0,a.useState)(null),[ge,M]=(0,a.useState)(!1),[q,J]=(0,a.useState)(""),[F,C]=(0,a.useState)(!1),[Q,h]=(0,a.useState)(null),m=(0,a.useMemo)(()=>g.filter(t=>u.has(t.ownerId)),[g,u]),E=m.map(t=>t.ownerId),X=JSON.stringify(m.map(t=>[t.ownerId,t.managedSessionId??t.advSessionId??null,t.launchStartedAt??null,t.sessionId??null])),Z=(0,a.useRef)(null),U=l?.killLabel??"Kill",ee=g.length>0&&g.every(t=>u.has(t.ownerId)),ue=t=>{b(n=>{const d=new Set(n);return d.has(t)?d.delete(t):d.add(t),d}),C(!1),h(null)},he=()=>{b(new Set(g.map(t=>t.ownerId))),C(!1),h(null)},te=()=>{b(new Set),C(!1),M(!1),h(null)},G=async(t,n,d)=>{Y(t),h(null);try{return h(await d()),!0}catch(A){return h(A instanceof Error&&A.message?A.message:n),!1}finally{Y(null)}},_e=async()=>{const t=q,n=l?.message;!t.trim()||E.length===0||!n||await G("message","Message failed",()=>n(E,t))&&(M(!1),J(""))},be=async()=>{E.length===0||!l?.wake||await G("wake","Wake failed",()=>l.wake(E))},me=async()=>{if(l?.focus){if(!m.some(t=>Ce(t))){h("None of the selected have a focusable window");return}await G("focus","Focus failed",()=>l.focus(m))}},fe=async()=>{if(!l?.kill)return;if(!F||Z.current!==X){Z.current=X,C(!0),h(null);return}const t=await G("kill",`${U} failed`,()=>l.kill(m));C(!1),t&&b(new Set)},xe=async()=>{if(l?.copyIds)try{h(await l.copyIds(E))}catch{h("Copy failed")}},ve=t=>`pc-agents-roster__row${L?"":" pc-agents-roster__row--nocheck"}${t.ownerId===I?" is-pinned":""}${u.has(t.ownerId)?" is-selected":""}`,se=t=>{if(D){D(t);return}N&&re(t)?N(t):R(n=>n===t.ownerId?null:t.ownerId)};return(0,e.jsxs)("div",{className:"pc-agents-roster",role:"group","aria-label":`${P} agents running`,"data-testid":"agents-roster",children:[z&&(0,e.jsx)("div",{className:"pc-agents-roster__tabs",role:"tablist","data-testid":"agents-machine-tabs",children:_.map(t=>(0,e.jsx)(S,{label:t.isLocal?"Agents on this machine":`Agents on ${t.label}`,side:"bottom",children:(0,e.jsxs)("button",{type:"button",role:"tab","aria-selected":t.key===w,className:`pc-agents-roster__tab${t.key===w?" is-active":""}`,"data-testid":`agents-machine-tab-${t.key}`,onClick:()=>v?.(t.key===_[0].key?null:t.key),children:[t.label," ",(0,e.jsx)("span",{className:"pc-agents-roster__tab-count",children:t.count})]})},t.key))}),(0,e.jsx)("div",{className:"pc-agents-roster__legend","aria-hidden":!0,children:$e.map(({kind:t,term:n,literal:d})=>(0,e.jsxs)("span",{className:"pc-agents-roster__legend-item",children:[ce[t]??"·"," ",n?f.term(n,{lower:!0}):d]},t))}),l&&m.length>0?(0,e.jsxs)("div",{className:"pc-agents-roster__bulkbar","data-testid":"agents-bulk-bar",role:"toolbar","aria-label":"Bulk agent actions",children:[(0,e.jsxs)("span",{className:"pc-agents-roster__bulk-count","data-testid":"agents-bulk-count",children:[m.length," selected"]}),l.message?(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-message",onClick:()=>{M(t=>!t),C(!1),h(null)},children:"✉ Message"}):null,l.wake?(0,e.jsx)(S,{label:"Re-invoke the selected agents (coord wake)",children:(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-wake",disabled:j==="wake",onClick:be,children:j==="wake"?"nudging…":"⏰ Wake"})}):null,l.focus?(0,e.jsx)(S,{label:"Raise the selected agents' terminal windows",children:(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-focus",disabled:j==="focus",onClick:me,children:j==="focus"?"focusing…":"⤢ Focus all"})}):null,l.copyIds?(0,e.jsx)(S,{label:"Copy the selected owner ids to the clipboard",children:(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-copy",onClick:xe,children:"⧉ Copy ids"})}):null,l.kill?(0,e.jsx)(S,{label:l.killDescription??"Close the selected agents' terminal windows (graceful — SIGHUPs the CLI)",children:(0,e.jsx)("button",{type:"button",className:`pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--danger${F?" is-armed":""}`,"data-testid":"agents-bulk-kill",disabled:j==="kill",onClick:fe,children:j==="kill"?"killing…":F?`⚠ Confirm ${U.toLowerCase()} ${m.length}?`:`✕ ${U}`})}):null,F&&l.kill?(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-kill-cancel",onClick:()=>C(!1),children:"Cancel"}):null,(0,e.jsx)("span",{className:"pc-agents-roster__bulk-spacer"}),(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost","data-testid":"agents-bulk-selectall",onClick:ee?te:he,children:ee?"Deselect all":"Select all"}),(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost","data-testid":"agents-bulk-clear",onClick:te,children:"Clear"}),ge?(0,e.jsxs)("div",{className:"pc-agents-roster__compose","data-testid":"agents-bulk-compose",children:[(0,e.jsx)("textarea",{className:"pc-agents-roster__compose-input","data-testid":"agents-bulk-msg",value:q,onChange:t=>J(t.target.value),placeholder:`Message ${m.length} agent${m.length===1?"":"s"}…`,rows:2,autoFocus:!0}),(0,e.jsxs)("div",{className:"pc-agents-roster__compose-actions",children:[(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn","data-testid":"agents-bulk-msg-send",disabled:j==="message"||q.trim().length===0,onClick:_e,children:j==="message"?"sending…":"Send"}),(0,e.jsx)("button",{type:"button",className:"pc-agents-roster__bulk-btn pc-agents-roster__bulk-btn--ghost",onClick:()=>M(!1),children:"Cancel"})]})]}):null]}):null,Q?(0,e.jsx)("div",{className:"pc-agents-roster__bulkbar",role:"status",children:(0,e.jsx)("span",{className:"pc-agents-roster__bulk-note","data-testid":"agents-bulk-note",children:Q})}):null,(0,e.jsx)("div",{className:"pc-agents-roster__scroll","data-testid":"agents-roster-scroll",children:y.map(t=>(0,e.jsxs)("section",{className:"pc-agents-roster__group",children:[(0,e.jsxs)("header",{className:"pc-agents-roster__group-head",style:t.slug?{color:t.color??void 0}:void 0,children:[(0,e.jsx)("span",{className:"pc-agents-roster__group-caret","aria-hidden":!0,children:"▾"}),t.slug??"No fleet"," ",(0,e.jsxs)("span",{className:"pc-agents-roster__group-count",children:["(",t.agents.length,")"]})]}),t.agents.map(n=>(0,e.jsxs)("div",{className:ve(n),"data-testid":`agent-row-${n.ownerId}`,"data-liveness":n.liveness,role:"button",tabIndex:0,onMouseEnter:()=>K(n.ownerId),onClick:()=>se(n),onKeyDown:d=>{(d.key==="Enter"||d.key===" ")&&(d.preventDefault(),se(n))},children:[L?(0,e.jsx)("input",{type:"checkbox",className:"pc-agents-roster__check","data-testid":`agent-select-${n.ownerId}`,checked:u.has(n.ownerId),"aria-label":`Select ${k(n)}`,onChange:()=>ue(n.ownerId),onClick:d=>d.stopPropagation(),onKeyDown:d=>d.stopPropagation()}):null,(0,e.jsxs)("span",{className:"pc-agents-roster__live",children:[le(n)?(0,e.jsx)(W,{size:7,title:`${k(n)} — thinking`}):(0,e.jsx)(B,{liveness:ie(n,o),size:7,title:oe(n,o)}),H(n.lastActiveAt??n.heartbeatAt,o)?(0,e.jsx)("span",{className:"pc-agents-roster__age",title:`last turn ${H(n.lastActiveAt??n.heartbeatAt,o)} ago`,children:H(n.lastActiveAt??n.heartbeatAt,o)}):null]}),(0,e.jsx)("span",{className:"pc-agents-roster__glyph",style:t.color?{color:t.color}:void 0,"aria-hidden":!0,children:V(n)}),(0,e.jsx)("span",{className:"pc-agents-roster__name",style:t.color?{color:t.color}:void 0,title:`${n.ownerId}${n.agent?` · ${n.agent}`:""}`,children:k(n)}),(0,e.jsxs)("span",{className:"pc-agents-roster__doing",title:n.intent||void 0,children:[n.feature?(0,e.jsx)("span",{className:"pc-agents-roster__feat",children:n.feature}):null,n.intent||(n.currentPlanSlug?n.currentPlanSlug:"—")]})]},n.ownerId))]},t.slug??"__none"))}),p?(0,e.jsx)(Te,{agent:p.agent,color:p.color,pinned:p.agent.ownerId===I,nowMs:o,labels:f,chrome:c,onInspect:N}):null,O]})}function Ae(s,o){const i=s.label?.trim();return i?o?o(i):i:s.coordOwnerId?ae(s.coordOwnerId):`${s.agent??"session"} #${s.id}`}function Le(s,o){const i=new Set(s.map(c=>c.id));return[...s,...o.filter(c=>!i.has(c.id))]}function Re(s,o,i){return i?s.filter(c=>c.coordOwnerId===i):s.filter(c=>!c.coordOwnerId||!o.has(c.coordOwnerId))}var ze=s=>!!s.coordOwnerId;function Me({activeOwnerIds:s,nowMs:o,focusOwnerId:i=null,expanded:c,onExpandedChange:f,loadPage:x,isOpenable:v=ze,onRowActivate:l,chrome:N=de,labels:D=pe,unopenableTitle:O="No transcript handle recorded for this session"}){const{LivenessDot:S}=N;(0,a.useEffect)(()=>{i&&f(!0)},[i]);const[B,W]=(0,a.useState)([]),[k,L]=(0,a.useState)(!0),[I,R]=(0,a.useState)(!1),[$,K]=(0,a.useState)(!1),T=(0,a.useRef)(null),_=(0,a.useRef)(!1),z=(0,a.useRef)(null),w=(0,a.useRef)(null),g=(0,a.useCallback)(async()=>{if(!_.current){_.current=!0,R(!0);try{const r=await x(T.current);T.current=r.nextBefore??null,L(!!r.hasMore),W(p=>Le(p,r.sessions??[]))}catch{K(!0),L(!1)}finally{_.current=!1,R(!1)}}},[x]);(0,a.useEffect)(()=>{c&&B.length===0&&!$&&g()},[c]),(0,a.useEffect)(()=>{if(!c)return;const r=w.current;if(!r||typeof IntersectionObserver>"u")return;const p=new IntersectionObserver(u=>{for(const b of u)b.isIntersecting&&k&&(_.current||g())},{root:z.current??null,rootMargin:"0px 0px 120px 0px"});return p.observe(r),()=>p.disconnect()},[c,k,g]);const y=Re(B,s,i),P=r=>{l&&v(r)&&l(r)};return(0,e.jsxs)("div",{className:"pc-agents-sessions__inactive","data-testid":"inactive-sessions-section",children:[(0,e.jsxs)("button",{type:"button",className:"pc-agents-sessions__toggle","data-testid":"inactive-sessions-toggle","aria-expanded":c,onClick:()=>f(!c),children:[(0,e.jsx)("span",{"aria-hidden":!0,children:c?"▾":"▸"})," View inactive sessions",c&&y.length>0?(0,e.jsxs)("span",{className:"pc-agents-roster__group-count","data-testid":"inactive-sessions-count",children:["(",y.length,k?"+":"",")"]}):null,(0,e.jsx)("span",{className:"pc-agents-sessions__toggle-hint",children:"every past session, newest first"})]}),c&&(0,e.jsxs)("div",{className:"pc-agents-sessions__scroll pc-agents-sessions__inactive-list",ref:z,"data-testid":"inactive-sessions-list",children:[y.map(r=>{const p=!!l&&v(r),u=r.endedAt?H(r.endedAt,o):"";return(0,e.jsxs)("div",{className:`pc-agents-roster__row pc-agents-roster__row--nocheck${p?"":" is-unopenable"}`,"data-testid":`inactive-session-${r.id}`,role:p?"button":void 0,tabIndex:p?0:void 0,title:p?"Open session":O,onClick:()=>P(r),onKeyDown:b=>{(b.key==="Enter"||b.key===" ")&&p&&(b.preventDefault(),P(r))},children:[(0,e.jsxs)("span",{className:"pc-agents-roster__live",children:[(0,e.jsx)(S,{liveness:"stale",size:7,title:u?`ended ${u} ago`:"ended session"}),u?(0,e.jsx)("span",{className:"pc-agents-roster__age",title:`ended ${u} ago`,children:u}):null]}),(0,e.jsx)("span",{className:"pc-agents-roster__glyph","aria-hidden":!0,children:V({agentPaneKind:null,role:r.role})}),(0,e.jsx)("span",{className:"pc-agents-roster__name",title:`${r.coordOwnerId??""}${r.agent?` · ${r.agent}`:""}`,children:Ae(r,D.agentLabel)}),(0,e.jsxs)("span",{className:"pc-agents-roster__doing",children:[r.feature?(0,e.jsx)("span",{className:"pc-agents-roster__feat",children:r.feature}):null,[r.planSlug,r.agent].filter(Boolean).join(" · ")||"—"]})]},r.id)}),I&&(0,e.jsx)("div",{className:"pc-agents-sessions__status",children:"Loading…"}),$&&(0,e.jsx)("div",{className:"pc-agents-sessions__status is-error",children:"Couldn’t load inactive sessions."}),!k&&!I&&!$&&y.length===0&&(0,e.jsx)("div",{className:"pc-agents-sessions__status",children:"No inactive sessions."}),(0,e.jsx)("div",{ref:w,"data-testid":"inactive-sessions-sentinel",style:{height:1}})]})]})}var Fe=`
      .pc-agents-roster { font-size: 12px; display: flex; flex-direction: column; min-height: 0; }
      .pc-agents-roster__tabs { display: flex; gap: 2px; padding: 4px 6px 0; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
      .pc-agents-roster__tab {
        font-size: 11px; padding: 3px 9px; border-radius: 6px 6px 0 0; cursor: pointer;
        background: transparent; color: var(--fg-mute); border: 1px solid transparent; border-bottom: none;
      }
      .pc-agents-roster__tab:hover { background: var(--bg-2); }
      .pc-agents-roster__tab.is-active { background: var(--bg-2); color: var(--fg); border-color: var(--border); }
      .pc-agents-roster__tab-count { color: var(--fg-mute); font-variant-numeric: tabular-nums; margin-left: 2px; }
      .pc-agents-roster__legend {
        display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 8px 6px;
        font-size: 10.5px; color: var(--fg-mute); border-bottom: 1px solid var(--border);
      }
      .pc-agents-roster__group { padding: 2px 0; }
      .pc-agents-roster__group-head {
        display: flex; align-items: baseline; gap: 4px; padding: 5px 8px 2px;
        font-weight: 600; font-size: 11.5px; color: var(--fg-mute);
      }
      .pc-agents-roster__group-count { font-weight: 400; color: var(--fg-mute); font-size: 10.5px; }
      .pc-agents-roster__row {
        /* Columns: [select checkbox][live dot+age][glyph][name][doing].
           The leading checkbox column is auto-width so it hugs the small box. The
           name column HUGS its content (max-content, capped via the name's own
           max-width) so a short id like "su-5577c" doesn't reserve a wide track and
           leave a big gap before the description — the description follows right
           after. The doing column takes the rest. The native checkbox input is the
           first grid item, so the template must carry the leading auto track for it
           or the row shatters (checkbox-less rows use --nocheck below, which drops
           it). */
        display: grid; grid-template-columns: auto max-content 16px minmax(40px, max-content) minmax(0, 1fr);
        align-items: center; gap: 8px; padding: 3px 8px; border-radius: 4px;
      }
      /* Rows WITHOUT the leading select checkbox — an inactive-session list, a
         search-result head, or a roster with no bulk actions — reuse this row for
         its look but render only 4 cells (age/glyph/name/doing). Using the
         5-column template above shifted every cell left by one and dumped the NAME
         into the fixed 16px glyph column, truncating it to a single letter. This
         modifier drops that leading checkbox track so the 4 cells land in their own
         columns. */
      .pc-agents-roster__row--nocheck {
        grid-template-columns: max-content 16px minmax(40px, max-content) minmax(0, 1fr);
      }
      .pc-agents-roster__row:hover { background: var(--bg-2); }
      .pc-agents-roster__row[data-liveness="stale"] { opacity: 0.5; }
      .pc-agents-roster__live { display: inline-flex; align-items: center; gap: 4px; }
      .pc-agents-roster__age {
        font-size: 9.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums;
        line-height: 1; white-space: nowrap;
      }
      .pc-agents-roster__glyph { text-align: center; }
      .pc-agents-roster__name {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        max-width: 200px; /* caps the hugged name track; longer names ellipsize */
      }
      .pc-agents-roster__doing {
        color: var(--fg-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-agents-roster__feat {
        font-family: ui-monospace, monospace; font-size: 10px; margin-right: 6px;
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-agents-roster__scroll { max-height: 380px; overflow-y: auto; flex: 0 1 auto; min-height: 60px; }
      .pc-agents-roster__row { cursor: pointer; }
      .pc-agents-roster__row.is-pinned { background: color-mix(in oklab, var(--accent), transparent 82%); }
      .pc-agents-roster__detail { border-top: 1px solid var(--border); padding: 6px 8px; background: var(--bg-2); }
      .pc-agents-roster__detail-head { font-size: 12px; margin-bottom: 4px; }
      .pc-agents-roster__detail-fleet, .pc-agents-roster__detail-live, .pc-agents-roster__detail-pin {
        color: var(--fg-mute); font-weight: 400;
      }
      .pc-agents-roster__detail-grid {
        display: grid; grid-template-columns: 68px 1fr; gap: 2px 8px; margin: 0; font-size: 11.5px;
      }
      .pc-agents-roster__detail-grid dt { color: var(--fg-mute); }
      .pc-agents-roster__detail-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-agents-roster__inspect {
        margin-top: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer;
        background: var(--accent, #38bdf8); color: var(--accent-ink, #051827);
        border: 1px solid var(--accent, #38bdf8); border-radius: 4px; font-weight: 600;
      }
      .pc-agents-roster__nothinking {
        margin-top: 6px; font-size: 10.5px; color: var(--fg-mute); font-style: italic;
      }
      /* Selected-row indication: tinted background + a left accent bar. Placed
         AFTER :hover/.is-pinned so a selected row stays visibly selected on hover.
         An 18%-oklab tint read as "no selection indication" in the Tauri/WebKitGTK
         webview (too subtle on a near-black --bg-1), so this is stronger + srgb
         (broadest color-mix support). The 4px inset bar is the robust primary cue
         (no color-mix dependency); the tint is the secondary. */
      .pc-agents-roster__row.is-selected {
        background: color-mix(in srgb, var(--accent, #38bdf8) 30%, transparent);
        box-shadow: inset 4px 0 0 var(--accent, #38bdf8);
      }
      .pc-agents-roster__row.is-selected:hover {
        background: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
      }
      /* A REAL native accent checkbox. A Radix <button>+svg restyle could not
         reproduce the approved native look even deployed, so this is a native
         <input type=checkbox>: accent-color tints the browser's own check with the
         theme accent, and color-scheme follows the surface so the unchecked box
         renders for it instead of the browser default. */
      .pc-agents-roster__check {
        width: 13px; height: 13px; box-sizing: border-box;
        margin: 0; padding: 0; align-self: center; flex: 0 0 auto;
        accent-color: var(--accent, #38bdf8);
        color-scheme: var(--pc-roster-color-scheme, dark);
        cursor: pointer;
      }
      .pc-agents-roster__bulkbar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
        padding: 5px 8px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
        background: color-mix(in oklab, var(--accent), transparent 90%); font-size: 11px;
      }
      .pc-agents-roster__bulk-count { font-weight: 600; margin-right: 4px; }
      .pc-agents-roster__bulk-spacer { flex: 1 1 auto; }
      .pc-agents-roster__bulk-btn {
        font: inherit; font-size: 11px; cursor: pointer; padding: 2px 8px; line-height: 1.4;
        background: var(--bg-1); color: var(--fg); border: 1px solid var(--border); border-radius: 5px;
      }
      .pc-agents-roster__bulk-btn:hover { border-color: var(--accent, #38bdf8); }
      .pc-agents-roster__bulk-btn:disabled { opacity: 0.55; cursor: default; }
      .pc-agents-roster__bulk-btn--ghost { background: transparent; color: var(--fg-mute); }
      .pc-agents-roster__bulk-btn--danger { color: #e5484d; border-color: color-mix(in oklab, #e5484d, transparent 55%); }
      .pc-agents-roster__bulk-btn--danger.is-armed { background: #e5484d; color: #fff; border-color: #e5484d; font-weight: 600; }
      .pc-agents-roster__bulk-note { color: var(--fg-mute); margin-left: 2px; }
      .pc-agents-roster__compose { flex: 1 1 100%; display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
      .pc-agents-roster__compose-input {
        font: inherit; font-size: 11px; width: 100%; resize: vertical; box-sizing: border-box;
        background: var(--bg-1); color: var(--fg); border: 1px solid var(--border); border-radius: 5px; padding: 4px 6px;
      }
      .pc-agents-roster__compose-actions { display: flex; gap: 4px; }
`,Ge=`
      .pc-agents-sessions__status { padding: 8px 10px; font-size: 11.5px; color: var(--fg-mute); font-style: italic; }
      .pc-agents-sessions__status.is-error { color: #d97757; }
      .pc-agents-sessions__scroll { max-height: 300px; overflow-y: auto; }
      .pc-agents-sessions__inactive {
        border-top: 1px solid var(--border-strong, var(--border)); margin-top: 4px;
        position: sticky; bottom: -4px; z-index: 2; background: var(--bg-1, #0b1525);
      }
      .pc-agents-sessions__toggle {
        width: 100%; text-align: left; font: inherit; font-size: 12px; font-weight: 600;
        padding: 8px 10px; cursor: pointer; display: flex; align-items: center; gap: 6px;
        background: transparent; color: var(--accent, #38bdf8); border: none; border-radius: 4px;
      }
      .pc-agents-sessions__toggle:hover { background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); }
      .pc-agents-sessions__toggle-hint { margin-left: auto; font-weight: 400; font-size: 10.5px; color: var(--fg-mute); }
      .pc-agents-sessions__inactive-list { max-height: 260px; }
      .pc-agents-sessions__inactive .pc-agents-roster__row.is-unopenable { cursor: default; opacity: 0.75; }
`;export{Pe as a,Ae as i,Fe as n,de as o,Me as r,V as s,Ge as t};
