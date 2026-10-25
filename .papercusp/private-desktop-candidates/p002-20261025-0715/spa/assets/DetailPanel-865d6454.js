import{o as be}from"./chunk-a1a4177d.js";import{t as _e}from"./react-ea1d8b8b.js";import{t as ye}from"./jsx-runtime-660d4162.js";import{t as je}from"./dist-54e97c5e.js";import{a as J,i as V,t as we}from"./chat-ref-popup-params-2dc4bc36.js";import{i as A}from"./SyncContext-10c8fc40.js";import{n as Ne,r as Se,t as ke}from"./dist-6bb724c5.js";import{l as F,o as W,r as Re}from"./dist-8935d6c3.js";import{t as K}from"./use-workspace-id-fc1e3d10.js";import{t as Ce}from"./Modal-429fa5c5.js";import{t as pe}from"./useConfirmDialog-36e9d9d8.js";import{t as ue}from"./arrow-up-right-346a70f8.js";import{a as me,i as Ae,n as $e,o as X,r as he}from"./primitives-874c53bf.js";import{t as Z}from"./message-circle-23cdbc08.js";import{t as Ee}from"./sensitive-text-52df1581.js";import{r as Te,t as Pe}from"./presence-ui-b557d5ff.js";import{t as O}from"./Tooltip-98086d04.js";import{n as ee}from"./useLexicon-e47d5e4a.js";import{t as ve}from"./Select-b03b554e.js";import{n as se}from"./list-meta-e0de96bd.js";import{h as De}from"./theme-7f2f666e.js";import{n as Ie,t as Oe}from"./WorkItemDiscussion-5d7dffce.js";import{n as Fe,t as fe}from"./agent-display-8cca97c9.js";import{t as ze}from"./HumanWorkSection-d29138d4.js";import{n as qe,t as Me}from"./work-item-presentation-contract-8eca98fe.js";var ie="papercusp:open-chat";async function ge(a){const t=a.dispatch!==!1;try{try{const o=await fetch(`/api/harness/${encodeURIComponent(a.slug)}/agent-chats`);if(o.ok){const s=((await o.json()).chats??[]).find(n=>n.role===a.role&&n.feature_id===a.featureId);if(s){const n={slug:a.slug,chatId:s.id,title:s.title??a.title,role:s.role,featureId:a.featureId,...a.mode?{mode:a.mode}:{}};if(t&&typeof window<"u"){const u=window,m=u.__PAPERCUSP_PENDING_CHAT_OPENS__??[];m.push(n),u.__PAPERCUSP_PENDING_CHAT_OPENS__=m,window.dispatchEvent(new CustomEvent(ie,{detail:n}))}return{chatId:s.id}}}}catch{}const i=await fetch(`/api/harness/${encodeURIComponent(a.slug)}/agent-chats`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({role:a.role,feature_id:a.featureId,title:a.title})});if(!i.ok)return{error:(await i.json().catch(()=>({}))).error??`HTTP ${i.status}`};const r=await i.json(),h={slug:a.slug,chatId:r.id,title:r.title,role:r.role,featureId:r.feature_id??void 0,...a.mode?{mode:a.mode}:{}};if(t&&typeof window<"u"){const o=window,s=o.__PAPERCUSP_PENDING_CHAT_OPENS__??[];s.push(h),o.__PAPERCUSP_PENDING_CHAT_OPENS__=s,window.dispatchEvent(new CustomEvent(ie,{detail:h}))}return{chatId:r.id}}catch(i){return{error:i.message}}}var S=je(),d=be(_e()),e=ye(),ne=["open","wip","blocked","needs-human","done","dropped"];function re(a){try{return JSON.parse(a)}catch{return a}}function Ue(a,t,i){return i||!t||!Array.isArray(a)?null:a.filter(r=>r.featureId===t).map(r=>({ts:r.ts,field:r.field,old:r.oldValue?re(r.oldValue):null,new:r.newValue?re(r.newValue):null,actor:r.actor??""}))}function We({slug:a,feature:t,onClose:i,onSaved:r,embedded:h=!1}){const o=K(),s=t===null,[n,u]=(0,d.useState)(t?.id??""),[m,v]=(0,d.useState)(t?.title??""),[l,c]=(0,d.useState)((t?.claims??[]).join(`
`)),[g,f]=(0,d.useState)(t?.status??"open"),[b,j]=(0,d.useState)(t?.attempts??0),[w,z]=(0,d.useState)(t?.deprecation_reason??""),[k,E]=(0,d.useState)(!1),[T,R]=(0,d.useState)(null),{confirm:q,element:$}=pe();(0,d.useEffect)(()=>{t&&(u(t.id),v(t.title),c((t.claims??[]).join(`
`)),f(t.status),j(t.attempts),z(t.deprecation_reason??""))},[t]);const C=(0,d.useCallback)(async()=>{E(!0);try{const x=l.split(`
`).map(N=>N.trim()).filter(Boolean);if(g==="dropped"&&w.trim()===""){R('Deprecation reason is required when status is "dropped".'),E(!1);return}if(s){const N=await fetch(`/api/harness/${a}/features`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:n,title:m,claims:x,status:g})});if(!N.ok)throw new Error(`${N.status}: ${await N.text()}`)}else{const N={title:m,claims:x,status:g,attempts:b};g==="dropped"&&(N.deprecation_reason=w.trim());const L=await fetch(`/api/harness/${a}/features/${n}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(N)});if(!L.ok)throw new Error(`${L.status}: ${await L.text()}`)}R("saved"),r(),setTimeout(()=>{i()},400)}catch(x){R(`save failed: ${x}`)}finally{E(!1)}},[a,n,m,l,g,b,s,i,r]),D=(0,d.useCallback)(async()=>{if(t&&await q({title:`Delete feature ${t.id}?`,body:"This cannot be undone.",confirmLabel:"Delete",destructive:!0})){E(!0);try{const x=await fetch(`/api/harness/${a}/features/${t.id}`,{method:"DELETE"});if(!x.ok)throw new Error(`${x.status}: ${await x.text()}`);R("deleted"),r(),setTimeout(()=>{i()},400)}catch(x){R(`delete failed: ${x}`)}finally{E(!1)}}},[a,t,i,r,q]),[P,B]=F("history",Re.withDefault(!1)),[p,_]=(0,d.useState)(null),{data:y}=A({queryName:"featureAudit.byHarness",args:{harnessSlug:a,workspaceId:o},enabled:!s&&!!a}),I=(0,d.useMemo)(()=>Ue(y,t?.id,s),[y,s,t?.id]);(0,d.useEffect)(()=>{const x=N=>{(N.metaKey||N.ctrlKey)&&N.key.toLowerCase()==="s"&&(N.preventDefault(),C())};return window.addEventListener("keydown",x),()=>window.removeEventListener("keydown",x)},[C]);const ae=(0,e.jsxs)(e.Fragment,{children:[$,(0,e.jsxs)("div",{style:{padding:"0.75rem 1rem",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:"0.75rem"},children:[(0,e.jsx)("strong",{style:{color:"var(--fg)"},children:s?"New feature":`Edit ${t.id}`}),(0,e.jsx)("span",{style:{color:"var(--fg-mute)",fontSize:"0.75rem",fontFamily:"monospace"},title:"Features live in Postgres (harness_features); edits dispatch via /api/harness/<slug>/features",children:"harness_features"}),(0,e.jsxs)("div",{style:{marginLeft:"auto",display:"flex",gap:"0.5rem",alignItems:"center"},children:[T&&(0,e.jsx)("span",{style:{color:/failed/i.test(T)?"var(--bad)":"var(--good)",fontSize:"0.8rem"},children:T}),!s&&(0,e.jsx)("button",{onClick:D,disabled:k,style:{background:"transparent",color:"var(--bad)",border:"1px solid #7f1d1d",borderRadius:3,padding:"0.35rem 0.75rem",cursor:k?"wait":"pointer",fontSize:"0.8rem"},children:"delete"}),(0,e.jsx)("button",{onClick:C,disabled:k||!m.trim()||s&&!n.trim(),style:{background:"#2563eb",color:"white",border:"none",borderRadius:3,padding:"0.35rem 0.9rem",cursor:k?"wait":"pointer",fontWeight:600},children:k?"saving…":"save"}),(0,e.jsx)("button",{onClick:i,style:{background:"transparent",color:"var(--fg-mute)",border:"1px solid var(--border)",borderRadius:3,padding:"0.35rem 0.75rem",cursor:"pointer"},children:"cancel"})]})]}),(0,e.jsxs)("div",{style:{flex:1,overflow:"auto",padding:"1rem",display:"flex",flexDirection:"column",gap:"0.9rem"},children:[(0,e.jsxs)("div",{children:[(0,e.jsx)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:"ID"}),(0,e.jsx)("input",{value:n,onChange:x=>u(x.target.value.toUpperCase()),disabled:!s,placeholder:"F-NEW-001",style:{width:"100%",boxSizing:"border-box",background:s?"#111827":"#1f2937",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontFamily:"monospace",fontSize:"0.85rem",opacity:s?1:.6}}),s&&(0,e.jsxs)("div",{style:{fontSize:"0.7rem",color:"var(--fg-mute)",marginTop:"0.25rem"},children:["must match ",(0,e.jsx)("code",{children:"^F-[A-Z0-9-]+$"}),". Convention: ",(0,e.jsx)("code",{children:"F-FIX-001"})," for fix features."]})]}),(0,e.jsxs)("div",{children:[(0,e.jsx)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:"Title"}),(0,e.jsx)("textarea",{value:m,onChange:x=>v(x.target.value),rows:2,style:{width:"100%",boxSizing:"border-box",background:"var(--bg-2)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontSize:"0.85rem",resize:"vertical",fontFamily:"system-ui, sans-serif"}})]}),(0,e.jsxs)("div",{children:[(0,e.jsx)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:"Claims — one per line (validation contract IDs)"}),(0,e.jsx)("textarea",{value:l,onChange:x=>c(x.target.value),rows:6,placeholder:`VAL-GRID-001
VAL-GRID-002`,style:{width:"100%",boxSizing:"border-box",background:"var(--bg-2)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontSize:"0.8rem",fontFamily:"ui-monospace, monospace",resize:"vertical"}})]}),(0,e.jsxs)("div",{style:{display:"flex",gap:"1rem"},children:[(0,e.jsxs)("div",{style:{flex:1},children:[(0,e.jsx)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:"Status"}),(0,e.jsx)(ve,{value:g,onChange:x=>f(x),ariaLabel:"Status",options:[...ne.map(x=>({value:x,label:x})),...ne.includes(g)?[]:[{value:g,label:`${g} (legacy)`}]],triggerStyle:{width:"100%",boxSizing:"border-box",background:"var(--bg-2)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontSize:"0.85rem"}})]}),!s&&(0,e.jsxs)("div",{style:{flex:1},children:[(0,e.jsx)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:"Attempts"}),(0,e.jsx)("input",{type:"number",min:0,value:b,onChange:x=>j(Math.max(0,Math.floor(Number(x.target.value)||0))),style:{width:"100%",boxSizing:"border-box",background:"var(--bg-2)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontSize:"0.85rem"}})]})]}),g==="dropped"&&(0,e.jsxs)("div",{children:[(0,e.jsxs)("label",{style:{display:"block",fontSize:"0.75rem",color:"var(--fg-mute)",marginBottom:"0.25rem"},children:["Deprecation reason ",(0,e.jsx)("span",{style:{color:"var(--bad)"},children:"(required)"})]}),(0,e.jsx)("textarea",{value:w,onChange:x=>z(x.target.value),placeholder:"e.g. The plan no longer asks for JWT cookie rotation; replaced by F-AUTH-012 (session cookies).",rows:3,style:{width:"100%",boxSizing:"border-box",background:"var(--bg-2)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:3,padding:"0.45rem 0.6rem",fontSize:"0.85rem",fontFamily:"inherit",resize:"vertical"}}),(0,e.jsx)("p",{style:{margin:"0.35rem 0 0",fontSize:"0.7rem",color:"var(--fg-mute)"},children:"Code is not auto-removed when a feature is deprecated; the row stays for audit and is hidden from default queue views."})]}),!s&&(0,e.jsxs)(Ne,{open:P,onOpenChange:B,style:{marginTop:"0.5rem",borderTop:"1px solid var(--border)",paddingTop:"0.6rem"},children:[(0,e.jsx)(Se,{asChild:!0,children:(0,e.jsxs)("button",{type:"button",style:{cursor:"pointer",fontSize:"0.8rem",color:"var(--fg-mute)",userSelect:"none",background:"none",border:"none",padding:0,textAlign:"left"},children:["History ",I?`(${I.length})`:""]})}),(0,e.jsxs)(ke,{style:{marginTop:"0.5rem",fontSize:"0.75rem",maxHeight:240,overflowY:"auto"},children:[p&&(0,e.jsxs)("div",{style:{color:"var(--bad)"},children:["Failed to load: ",p]}),!p&&I===null&&P&&(0,e.jsx)("div",{style:{color:"var(--fg-mute)"},children:"Loading…"}),!p&&I!==null&&I.length===0&&(0,e.jsx)("div",{style:{color:"var(--fg-mute)"},children:"No edit history yet."}),I&&I.length>0&&(0,e.jsx)("div",{style:{display:"flex",flexDirection:"column",gap:"0.25rem"},children:I.map((x,N)=>{const L=M=>M==null?"∅":typeof M=="string"?M.length>40?M.slice(0,37)+"…":M:JSON.stringify(M).slice(0,40);return(0,e.jsxs)("div",{style:{display:"grid",gridTemplateColumns:"11ch 9ch 1fr",gap:"0.5rem",alignItems:"baseline",color:"var(--fg)"},children:[(0,e.jsx)("span",{style:{color:"var(--fg-mute)",fontVariantNumeric:"tabular-nums"},children:new Date(x.ts).toLocaleString(void 0,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}),(0,e.jsx)("span",{style:{color:"#a1a1aa"},children:x.actor}),(0,e.jsxs)("span",{children:[(0,e.jsx)("code",{style:{color:"var(--warn)"},children:x.field}),(0,e.jsx)("span",{style:{color:"var(--fg-mute)"},children:": "}),(0,e.jsx)("span",{style:{color:"var(--fg-mute)"},children:L(x.old)}),(0,e.jsx)("span",{style:{color:"var(--fg-mute)"},children:" → "}),(0,e.jsx)("span",{children:L(x.new)})]})]},N)})})]})]})]})]});return h?(0,e.jsx)("div",{style:{height:"100%",minHeight:0,display:"flex",flexDirection:"column",overflow:"hidden",background:"var(--bg-1, #0b1220)",fontFamily:"system-ui, sans-serif"},children:ae}):(0,e.jsx)(Ce,{open:!0,onOpenChange:x=>{x||i()},title:"Edit feature",srOnlyTitle:!0,contentStyle:{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:6,width:"70vw",maxWidth:720,height:"65vh",display:"flex",flexDirection:"column",overflow:"hidden",fontFamily:"system-ui, sans-serif"},children:ae})}function oe(a){if(a){if(Array.isArray(a))return a.map(t=>String(t));if(typeof a=="string")try{const t=JSON.parse(a);if(Array.isArray(t))return t.map(i=>String(i))}catch{}}}function Be(a){if(a==null)return;let t;if(Array.isArray(a))t=a;else if(typeof a=="string"){const r=a.trim();if(!r||r==="{}"||r==="[]")return;if(r.startsWith("{")&&r.endsWith("}"))t=r.slice(1,-1).split(",");else try{const h=JSON.parse(r);t=Array.isArray(h)?h:[]}catch{return}}else return;const i=t.map(r=>typeof r=="number"?r:Number.parseInt(String(r).trim(),10)).filter(r=>Number.isInteger(r)&&r>0);return i.length>0?i:void 0}function Le(a){return{id:a.featureId,title:a.title,summary:a.summary??void 0,status:a.status,attempts:Number(a.attempts)||0,claims:oe(a.claims),sourcePlanSlug:a.sourcePlanSlug??void 0,needsReview:a.needsHumanReview??a.needs_human_review??void 0,tags:oe(a.tags),workingUsers:Be(a.workingUsers??a.working_users)}}function He(a,t,i=!0){const r=K(),h=i&&!!a&&!!t,[o,s]=(0,d.useState)({featureId:"",feature:null,loaded:!1}),{data:n,loading:u,error:m}=A({queryName:"featuresConsolidated.detail",args:{harnessSlug:a,featureId:h?t:"",workspaceId:r},enabled:h});(0,d.useEffect)(()=>{if(!h){s({featureId:t,feature:null,loaded:!1});return}if(u||!Array.isArray(n))return;const g=n.find(f=>f.featureId===t);s({featureId:t,feature:g?Le(g):null,loaded:!0})},[h,t,n,u]);const v=(0,d.useCallback)((g,f)=>{s(b=>b.featureId===g&&b.feature?{...b,feature:{...b.feature,...f}}:b)},[]),l=m?m instanceof Error?m.message:String(m):null,c=o.featureId===t?o:null;return{feature:c?.feature??null,loading:h&&(!c?.loaded||u)&&!l,error:l,patchFeature:v}}function Je(a){const t=typeof a.foundAt=="number"?a.foundAt:Date.parse(String(a.foundAt));return{id:a.issueId,title:a.title,severity:a.severity,source:a.source,status:a.status,foundAt:Number.isFinite(t)?new Date(t).toISOString():"",foundDuring:a.foundDuring??void 0,repro:a.repro??void 0,evidence:a.evidence??void 0,suggestedFix:a.suggestedFix??void 0,codePointer:a.codePointer??void 0,linkedFeatureId:a.linkedFeatureId??void 0,attempts:Number(a.attempts)||0,notes:Array.isArray(a.notes)?a.notes:[]}}function Ke(a){const t=K(),[i,r]=(0,d.useState)(null),[h,o]=(0,d.useState)(null),{data:s,loading:n,error:u}=A({queryName:"issuesConsolidated.bySlug",args:a?{harnessSlug:a,workspaceId:t}:void 0,enabled:!!a});(0,d.useEffect)(()=>{if(!a){r(null),o(null);return}n||!Array.isArray(s)||r(s.map(Je))},[a,s,n]),(0,d.useEffect)(()=>{o(u?u instanceof Error?u.message:String(u):null)},[u]);const{data:m}=A({queryName:"harnessPendingIssues.byHarness",args:a?{harnessSlug:a,phase:"staging",workspaceId:t}:void 0,enabled:!!a}),v=Array.isArray(m)?m.length:0,l=(0,d.useCallback)((c,g)=>{r(f=>f&&f.map(b=>b.id===c?{...b,...g}:b))},[]);return{issues:i,pendingCount:v,loading:i===null&&!h,error:h,patchIssue:l}}function le(a){if(a==null)return;if(typeof a=="number")return a;const t=Date.parse(String(a));return Number.isFinite(t)?t:void 0}function zt(a,t={}){const i=K(),r=t.runningOnly===!0,h=t.cursor??null,o=t.limit??250,s=A({queryName:"agentRunsConsolidated.bySlug",args:a?{harnessSlug:a,workspaceId:i,runningOnly:r,limit:o,...h?{cursor:h}:{}}:void 0,enabled:!!a}),n=A({queryName:"agentRunsConsolidated.summary",args:a?{harnessSlug:a,workspaceId:i,runningOnly:r}:void 0,enabled:!!a}),u=(0,d.useMemo)(()=>!a||!Array.isArray(s.data)?null:s.data.map(j=>({runId:j.runId,role:j.role,ts:le(j.ts),sizeBytes:Number(j.sizeBytes)||0,running:!!j.running,lastEventTs:le(j.lastEventTs),costUsd:j.costUsd!=null?Number(j.costUsd):void 0,featureId:j.featureId??void 0})),[a,s.data]),m=n.data?.[0]??null,v=m?m.facets.find(j=>j.key==="state")?.values.find(j=>j.value==="running")?.count??0:null,l=Array.isArray(s.data)&&typeof se(s.data)?.nextCursor=="string"?se(s.data).nextCursor:null,c=s.error??n.error,g=c?c instanceof Error?c.message:String(c):null,f=!!(s.fetching||n.fetching),b=(0,d.useCallback)(()=>{s.invalidate(),n.invalidate()},[s,n]);return{agents:u,total:m?.total??null,matched:m?.matched??null,running:v,nextCursor:l,fetching:f,loading:u===null&&!g,error:g,refresh:b}}function qt(a,t=300){const[i,r]=(0,d.useState)(null),[h,o]=(0,d.useState)(null),[s,n]=(0,d.useState)(0),u=(0,d.useCallback)(()=>n(m=>m+1),[]);return(0,d.useEffect)(()=>{if(!a){r(null);return}let m=!1;return o(null),fetch(`/api/harness/${encodeURIComponent(a)}/log/history?limit=${t}&phase=staging`).then(v=>v.ok?v.json():Promise.reject(new Error(`log/history ${v.status}`))).then(v=>{m||r(Array.isArray(v.events)?v.events:[])}).catch(v=>{m||o(v.message)}),()=>{m=!0}},[a,t,s]),{events:i,loading:i===null&&!h,error:h,refresh:u}}async function de(a,t){const i=await fetch(a,{method:"POST",headers:t!==void 0?{"content-type":"application/json"}:void 0,body:t!==void 0?JSON.stringify(t):void 0});if(!i.ok)throw new Error(`${i.status}: ${await i.text()}`)}function xe(a){switch(a){case"acknowledge":return"acknowledged";case"close":return"closed";case"wontfix":return"wontfix";default:return null}}async function Ve(a,t,i){const r=`/api/harness/${encodeURIComponent(a)}/issues/${encodeURIComponent(t)}`;i==="promote"?await de(`${r}/promote`,{}):await de(`${r}/update`,{status:xe(i)})}function Ge(a){const t=a.spawnStatus?.trim()||null,i=a.errorMessage?.trim()||void 0;switch(t){case"done":return{kind:"done",label:"done"};case"failed":return{kind:"failed",label:`failed${a.exitCode!=null&&a.exitCode!==0?` (exit ${a.exitCode})`:""}`,detail:i};case"cancelled":return{kind:"cancelled",label:"cancelled",detail:i};case"reaped":return{kind:"muted",label:"reaped",detail:i};case"running":case"restarting":return{kind:"running",label:t};default:return a.running?{kind:"running",label:"running"}:null}}function Ye(a){if(!a)return"Work evidence unknown";const t=a.recentItemWork.status==="recent"?"Recent item update":a.recentItemWork.status==="stale"?"Older item update":"Item updates unknown";return[a.reservation?"Reserved":"Unreserved",t,a.waiting.status==="registered"?"Registered item wait":"Wait evidence unknown","Work attestation unknown"].join(" · ")}var Qe=["open","wip","blocked","needs-human","done","dropped"],H=[],Q=!1;async function Xe(a,t){try{const i=await fetch("/api/adv/sessions/launch-su",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agent:"claude",harness_slug:a,resume_session_id:t})}),r=await i.json().catch(()=>({}));if(!i.ok||r.status==="error")throw new Error(r.error||`${i.status}`);S.toast.success(`Session ${t.slice(0,12)}… opening in a terminal.`)}catch(i){S.toast.error("Open session failed",{description:String(i)})}}function te(a){const t=typeof a=="number"?a:Date.parse(String(a));if(!Number.isFinite(t))return"";const i=Math.max(0,Math.round((Date.now()-t)/1e3));if(i<60)return`${i}s ago`;const r=Math.round(i/60);if(r<60)return`${r}m ago`;const h=Math.round(r/60);return h<24?`${h}h ago`:`${Math.round(h/24)}d ago`}function Ze(a){return a.trim()?a.split(/^## \S+ \d{4}-\d{2}-\d{2}T[^\n]+\s*$/gm).map(t=>t.trim()).filter(Boolean):[]}function et(a){return a?a.startsWith("F-")?"feature":a.startsWith("I-")?"issue":a.startsWith("agent:")?"agent":"workItem":null}function Mt({params:a,api:t}){const i=ee(),r=i("workUnit",{lower:!0}),h=i("workUnit",{plural:!0,lower:!0}),o=a.harnessSlug||"",s=a.itemId||null,[n,u]=F("sel",W.withDefault("")),[m,v]=F("edit",W.withDefault("")),l=s??n,c=(0,d.useMemo)(()=>et(l),[l]),{feature:g,loading:f,error:b,patchFeature:j}=He(o,c==="feature"?l:"",c==="feature"),{issues:w,patchIssue:z}=Ke(o),k=(0,d.useCallback)(y=>{u(y||null),v(null)},[u,v]),E=(0,d.useRef)("");(0,d.useEffect)(()=>{if(s)return;if(Q){Q=!1,E.current=n;return}const y=E.current;y&&y!==n&&(H.push(y),H.length>50&&H.shift()),E.current=n},[n,s]);const T=(0,d.useCallback)(()=>{const y=H.pop();y!==void 0&&(Q=!0,u(y||null))},[u]),R=!s&&H.length>0?T:void 0,{data:q}=A({queryName:"agentRunsConsolidated.bySlug",args:{harnessSlug:o,workspaceId:K(),featureId:c==="feature"?l:"",limit:3},enabled:!!o&&c==="feature"&&!!l}),$=(0,d.useMemo)(()=>c==="issue"?(w??[]).find(y=>y.id===l)??null:null,[c,w,l]),C=A({queryName:"workItems.detail",requestClass:"interactive-control",args:{harnessSlug:o,id:c==="workItem"?l:""},enabled:!!o&&c==="workItem"&&!!l}),D=C.loading?null:C.data?.[0]??null,P=(0,d.useMemo)(()=>c==="workItem"&&D?.id===l?D:null,[c,D,l]),B=A({queryName:"fleetAssignments.byHarness",args:{harnessSlug:o},enabled:!!o&&c==="agent"}),p=B.loading?null:B.data,_=(0,d.useMemo)(()=>c==="agent"?(p??[]).find(y=>`agent:${y.agentId}`===l)??null:null,[c,p,l]);if((0,d.useEffect)(()=>{s?t.setTitle(s):g?t.setTitle(`Detail · ${g.id}`):$?t.setTitle(`Detail · ${$.id}`):P?t.setTitle(`Detail · ${P.id}`):_?t.setTitle(`Detail · ${fe(_.name??_.label??_.agentId,i)}`):t.setTitle("Detail")},[t,s,g,$,P,_,i]),!o)return(0,e.jsxs)(U,{children:["Pick a ",i("pot",{lower:!0})," to inspect its ",h,"."]});if(!l)return(0,e.jsxs)(U,{children:["Pick a ",r," from the list to inspect."]});if(l&&!g&&!$&&!P&&!_){const y=C.error??(C.failureCount>0?C.failureReason:null);return c==="workItem"&&y?(0,e.jsxs)(U,{tone:"error",children:["Unable to load ",l,": ",y.message]}):c==="feature"&&f||c==="issue"&&w===null||c==="workItem"&&C.loading||c==="agent"&&p===null?(0,e.jsxs)(U,{children:["Loading ",l,"…"]}):c==="feature"&&b?(0,e.jsxs)(U,{tone:"error",children:["Unable to load ",l,": ",b]}):c==="agent"?(0,e.jsxs)(U,{children:["Agent ",l.slice(6)," is no longer working here."]}):(0,e.jsxs)(U,{tone:"error",children:["No ",r," found for ",l,"."]})}return g?(0,e.jsx)(pt,{slug:o,feature:g,issues:w??[],runs:Array.isArray(q)?q:[],onSelect:k,onBack:R,patchFeature:j,isEditing:!s&&m===g.id,onStartEdit:()=>{v(g.id)},onCloseEdit:()=>{v(null)}}):$?(0,e.jsx)(ut,{slug:o,issue:$,onSelect:k,onBack:R,patchIssue:z}):P?(0,e.jsx)(at,{slug:o,workItem:P,onSelect:k,onBack:R}):_?(0,e.jsx)(tt,{agent:_,onSelect:k,onBack:R}):null}function tt({agent:a,onSelect:t,onBack:i}){const r=ee(),h=Te(a.heartbeatAt??""),o=s=>!!s&&(s.startsWith("F-")||s.startsWith("I-")||s.startsWith("WI-"));return(0,e.jsxs)("div",{className:"pc-adv-detail pc-adv-detail--compact",children:[(0,e.jsxs)("header",{className:"pc-adv-detail__header",children:[(0,e.jsx)(G,{onBack:i}),(0,e.jsx)("div",{className:"pc-adv-detail__id",children:a.agentId}),(0,e.jsx)("div",{className:"pc-adv-detail__title",children:fe(a.name??a.label??a.agentId,r)}),(0,e.jsxs)("div",{className:"pc-adv-detail__meta",children:[(0,e.jsx)($e,{kind:a.agentPaneKind,size:"xs"}),(0,e.jsxs)("span",{className:"pc-adv-detail__liveness",children:[(0,e.jsx)(Pe,{liveness:h,title:""}),h,a.heartbeatAt?(0,e.jsxs)("span",{className:"pc-adv-detail__muted",children:[" · heartbeat ",te(a.heartbeatAt)]}):null]}),a.driveMode?(0,e.jsxs)("span",{className:"pc-adv-detail__stat",children:["drive: ",a.driveMode]}):null,a.load>0?(0,e.jsxs)("span",{className:"pc-adv-detail__stat",children:["load: ",a.load]}):null,a.orphaned&&(0,e.jsx)(O,{label:"This agent holds claims but is no longer present — its work may need re-placing.",children:(0,e.jsx)("span",{className:"pc-adv-detail__warn-chip",children:"orphaned claims"})}),a.declaredUnclaimed&&(0,e.jsx)(O,{label:"Declared an intent without claiming items — invisible to fleet placement.",children:(0,e.jsx)("span",{className:"pc-adv-detail__warn-chip",children:"declared, unclaimed"})})]})]}),(0,e.jsxs)("section",{className:"pc-adv-detail__body",children:[a.intent?(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Intent"}),(0,e.jsx)("p",{className:"pc-adv-detail__prose",children:a.intent})]}):null,(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Working on"}),a.doing?(0,e.jsxs)("div",{className:"pc-adv-detail__related",children:[(0,e.jsx)(O,{label:a.doing.title,children:(0,e.jsxs)("button",{type:"button","data-testid":"agent-detail-doing",className:"pc-adv-detail__related-row",disabled:!o(a.doing.id),onClick:()=>o(a.doing.id)&&t(a.doing.id),children:[(0,e.jsx)("span",{className:"pc-adv-detail__related-id",children:a.doing.id}),(0,e.jsx)("span",{className:"pc-adv-detail__related-title",children:a.doing.title})]})}),a.queued.length>0&&(0,e.jsx)("div",{className:"pc-adv-detail__queue",children:a.queued.map((s,n)=>(0,e.jsx)("button",{type:"button",className:"pc-adv-detail__queue-chip",disabled:!o(s.id),onClick:()=>o(s.id)&&t(s.id),children:s.id},`${s.id}-${n}`))})]}):(0,e.jsx)("p",{className:"pc-adv-detail__muted",children:"Nothing claimed right now."})]}),a.claims.length>0&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsxs)("h3",{children:["Claims (",a.claims.length,")"]}),(0,e.jsx)("div",{className:"pc-adv-detail__related",children:a.claims.map((s,n)=>(0,e.jsxs)("div",{className:"pc-adv-detail__claim-row",children:[(0,e.jsx)("span",{className:"pc-adv-detail__related-id",children:o(s.id)?(0,e.jsx)("button",{type:"button",className:"pc-adv-detail__link pc-adv-detail__link-btn",onClick:()=>t(s.id),children:s.id}):s.id??s.type}),(0,e.jsx)("span",{className:"pc-adv-detail__claim-type",children:s.type}),(0,e.jsx)("span",{className:"pc-adv-detail__related-title",title:s.detail,children:s.detail})]},`${s.id??s.detail}-${n}`))})]})]}),(0,e.jsx)(Y,{})]})}function at({slug:a,workItem:t,onSelect:i,onBack:r,showChatAction:h=!0,showDiscussionAction:o=!0}){const[s,n]=(0,d.useState)(!1),[,u]=F(we,W),m=async()=>{n(!0);try{const l=await ge({slug:a,role:"worker",featureId:t.id,title:t.title,mode:"discuss"});if(l&&typeof l=="object"&&"error"in l)throw new Error(String(l.error))}catch(l){S.toast.error("Open chat failed",{description:String(l)})}finally{n(!1)}},v=[["Kind",(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(Ae,{kind:t.kind,size:"xs"})," ",(0,e.jsxs)("span",{className:"pc-adv-detail__muted",children:["(",t.family," family)"]})]})],["State",t.family==="issue"?(0,e.jsx)(he,{status:t.state,size:"xs"}):(0,e.jsx)(X,{status:t.state,size:"xs"})],["Acceptance",t.presentation?Me[t.presentation.stage]:"—"],["Work evidence",Ye(t.presentation?.workEvidence)],["Reason",t.presentation?(()=>{const[l,...c]=t.presentation.reason.split(": ");return`${qe[l]??l}${c.length?`: ${c.join(": ")}`:""}`})():"—"],["Severity",t.severity?(0,e.jsx)(me,{severity:t.severity,size:"xs"}):"—"],["Assignee",t.assignee?`${t.assignee}${t.assignedBy?` · by ${t.assignedBy}`:""}`:"—"],["Priority",t.priority??"—"],["Rank",t.rank??"—"],["Stage",t.spineRole?`${t.spineRole}${t.spineStatus?` (${t.spineStatus})`:""}`:"—"],["Updated",t.updatedAt?(0,e.jsx)("span",{title:new Date(t.updatedAt).toLocaleString(),children:te(t.updatedAt)}):"—"]];return(0,e.jsxs)("div",{className:"pc-adv-detail pc-adv-detail--compact",children:[(0,e.jsxs)("header",{className:"pc-adv-detail__header",children:[(0,e.jsx)(G,{onBack:r}),(0,e.jsx)("div",{className:"pc-adv-detail__id",children:t.id}),(0,e.jsx)("div",{className:"pc-adv-detail__title",children:t.title})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__body",children:[(0,e.jsxs)("div",{className:"pc-adv-detail__section pc-adv-detail__fields",children:[v.map(([l,c])=>(0,e.jsxs)("div",{className:"pc-adv-detail__field-row",children:[(0,e.jsx)("span",{className:"pc-adv-detail__field-label",children:l}),(0,e.jsx)("span",{children:c})]},l)),t.planSlug?(0,e.jsxs)("div",{className:"pc-adv-detail__field-row",children:[(0,e.jsx)("span",{className:"pc-adv-detail__field-label",children:"Plan"}),(0,e.jsxs)("button",{type:"button",className:"pc-adv-detail__link pc-adv-detail__link-btn",onClick:()=>{u(J(a,t.planSlug))},children:[t.planSlug," · decisions"]})]}):null]}),t.reporterStatus?(0,e.jsx)(st,{slug:a,workItem:t}):null,t.presentation&&(t.presentation.evidenceRefs.length>0||t.presentation.completionRef)?(0,e.jsxs)("div",{className:"pc-adv-detail__section","aria-label":"Acceptance evidence",children:[(0,e.jsx)("h3",{children:"Acceptance evidence and completion"}),[...t.presentation.evidenceRefs,...t.presentation.completionRef?[t.presentation.completionRef]:[]].map((l,c)=>(0,e.jsx)("div",{children:/^(WI|EI|F|I|BA)-\d+$/.test(l)?(0,e.jsx)("button",{type:"button",className:"pc-adv-detail__link pc-adv-detail__link-btn",onClick:()=>i(l),children:l}):/^https?:\/\//.test(l)?(0,e.jsx)("a",{className:"pc-adv-detail__link",href:l,target:"_blank",rel:"noreferrer",children:l}):(0,e.jsx)("code",{className:"pc-adv-detail__pointer",children:l})},`${l}-${c}`))]}):null,t.summary?(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__prose",children:t.summary})}):null,t.payload?.humanWork?.route==="market"?(0,e.jsx)(ze,{slug:a,id:t.id,refreshKey:t.updatedAt}):null,t.family==="feature"&&t.id.startsWith("F-")?(0,e.jsxs)("button",{type:"button",className:"pc-adv-detail__link pc-adv-detail__link-btn",onClick:()=>i(t.id),children:["Open feature detail ",(0,e.jsx)(ue,{size:12})]}):null,h?(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__actions",children:(0,e.jsxs)("button",{type:"button","data-testid":"wi-detail-chat",disabled:s,onClick:()=>{m()},children:[(0,e.jsx)(Z,{size:13,"aria-hidden":!0})," Chat"]})})}):null,o?(0,e.jsx)(it,{slug:a,workItem:t}):null,(0,e.jsx)(rt,{slug:a,workItem:t}),(0,e.jsx)(lt,{slug:a,workItem:t}),(0,e.jsx)(ct,{slug:a,workItem:t})]}),(0,e.jsx)(Y,{})]})}function st({slug:a,workItem:t}){const[i,r]=(0,d.useState)(""),[h,o]=(0,d.useState)(null),[s,n]=(0,d.useState)(!1),[u,m]=(0,d.useState)(!1),[v,l]=(0,d.useState)(null),c=t.reporterStatus;if((0,d.useEffect)(()=>{r(""),o(null),m(!1),l(null)},[t.id,c?.followUp?.question.id]),!c)return null;const g=async()=>{if(!(!h||!c.followUp)){n(!0),l(null);try{const f=await fetch("/api/desktop/report-problem",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"answer-follow-up",id:c.sourceId,harness:a,questionId:c.followUp.question.id,text:h})}),b=await f.json();if(!f.ok)throw new Error(b.error??`HTTP ${f.status}`);m(!0)}catch(f){l(f instanceof Error?f.message:String(f))}finally{n(!1)}}};return(0,e.jsxs)("section",{className:"pc-adv-detail__section","aria-label":"Your report",children:[(0,e.jsx)("h3",{children:"Your report"}),(0,e.jsx)("p",{role:"status",children:c.label}),c.followUp?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("p",{children:c.followUp.question.text}),c.followUp.answer?(0,e.jsxs)("p",{children:["Your reply: ",c.followUp.answer.text]}):u?(0,e.jsx)("p",{children:"Your reply was saved and queued for delivery."}):t.origin==="local"?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("label",{children:["Your reply",(0,e.jsx)("textarea",{value:i,maxLength:4e3,onChange:f=>{r(f.target.value),o(null)}})]}),(0,e.jsx)("button",{type:"button",disabled:!i.trim()||s,onClick:()=>o(Ee(i.trim())),children:"Review reply"}),h?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("pre",{children:h}),(0,e.jsx)("button",{type:"button",disabled:s,onClick:()=>{g()},children:s?"Sending…":"Send reply"})]}):null]}):null]}):null,v?(0,e.jsx)("p",{role:"alert",children:v}):null]})}function it({slug:a,workItem:t}){const i=(0,d.useRef)(null),[r,h]=F(Oe,W),o=(0,d.useMemo)(()=>V(r),[r]),s=o.id===t.id&&(!o.harness||o.harness===a);return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__actions",children:(0,e.jsxs)("button",{ref:i,type:"button","data-testid":"wi-detail-discuss","aria-expanded":s,"aria-controls":`work-item-discussion-${t.id}`,onClick:()=>{h(s?null:J(a,t.id))},children:[(0,e.jsx)(Z,{size:13,"aria-hidden":!0})," Discuss with Papercup"]})})}),s?(0,e.jsx)(Ie,{harnessSlug:a,workItemId:t.id,title:t.title,onClose:()=>{i.current?.focus({preventScroll:!0}),h(null)}}):null]})}var nt="wipa";function rt({slug:a,workItem:t}){const[i,r]=F(nt,W),h=(0,d.useMemo)(()=>V(i),[i]),o=h.id===t.id&&(!h.harness||h.harness===a),s=A({queryName:"workItems.priorAttempts",args:{harnessSlug:a,workItemId:t.id},enabled:o&&!!a&&!!t.id}),n=s.loading?null:s.data?.[0]??null,u=n?.brief??null;return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__actions",children:(0,e.jsxs)("button",{type:"button","data-testid":"wi-detail-prior-attempts","aria-expanded":o,"aria-controls":`work-item-prior-attempts-${t.id}`,onClick:()=>{r(o?null:J(a,t.id))},children:["Prior attempts",u?` (${u.attempts.length})`:""]})})}),o?(0,e.jsx)("div",{id:`work-item-prior-attempts-${t.id}`,className:"pc-adv-detail__section",children:s.loading?(0,e.jsx)("div",{className:"det-label",children:"Compiling prior-attempt brief…"}):u?(0,e.jsxs)(e.Fragment,{children:[u.authority.length>0?(0,e.jsx)(ce,{title:"Governing (current spec, decisions, retractions)",records:u.authority}):null,u.attempts.length>0?(0,e.jsx)(ce,{title:"Attempts",records:u.attempts}):(0,e.jsx)("div",{className:"det-label",children:"No prior attempts recorded on this lane."}),u.residue.length>0?(0,e.jsxs)("div",{children:[(0,e.jsx)("div",{className:"det-label",children:"Residue (left behind by earlier work)"}),u.residue.map(m=>(0,e.jsx)("div",{children:m.items.map((v,l)=>(0,e.jsxs)("div",{children:["• ",v]},`${m.rawRef}:${l}`))},m.rawRef))]}):null,u.omission.omittedRecords>0?(0,e.jsxs)("div",{"data-testid":"wi-prior-attempts-omissions",children:[(0,e.jsxs)("div",{className:"det-label",children:[u.omission.omittedRecords," of ",u.omission.sourceCount," record(s) omitted by the budget",u.omission.omittedRefsTruncated?" — and the omitted-ref list itself was truncated":""]}),u.omission.omittedRefs.map(m=>(0,e.jsxs)("div",{title:`${m.authority} · ${m.scope}`,children:["• ",m.rawRef]},m.rawRef))]}):null,(0,e.jsxs)("div",{className:"det-label",children:["~",u.estimatedTokens," tokens · fingerprint ",u.fingerprint.slice(0,12)]})]}):(0,e.jsx)("div",{className:"det-label","data-testid":"wi-prior-attempts-unavailable",children:n?.unavailableReason==="work-item-not-found"?"Work item not found in this harness.":"Prior-attempt brief unavailable (the collector timed out or errored). This is NOT evidence that nothing was tried."})}):null]})}var ot="wibc";function lt({slug:a,workItem:t}){const[i,r]=F(ot,W),h=(0,d.useMemo)(()=>V(i),[i]),o=h.id===t.id&&(!h.harness||h.harness===a),s=A({queryName:"workItems.behaviorContract",args:{harnessSlug:a,workItemId:t.id},enabled:o&&!!a&&!!t.id}),n=s.loading?null:s.data?.[0]??null,u=n?.groups.reduce((m,v)=>m+v.staleEdges.length,0)??0;return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__actions",children:(0,e.jsxs)("button",{type:"button","data-testid":"wi-detail-behavior-contract","aria-expanded":o,"aria-controls":`work-item-behavior-contract-${t.id}`,onClick:()=>{r(o?null:J(a,t.id))},children:["Behavior contract",n?` (${n.enforceableCount})`:""]})})}),o?(0,e.jsx)("div",{id:`work-item-behavior-contract-${t.id}`,className:"pc-adv-detail__section",children:s.loading?(0,e.jsx)("div",{className:"det-label",children:"Resolving behavior contract…"}):!n||n.unavailableReason?(0,e.jsx)("div",{className:"det-label","data-testid":"wi-behavior-contract-unavailable",children:n?.unavailableReason==="work-item-not-found"?"Work item not found in this harness.":"Behavior contract unavailable (the resolver errored). This is NOT evidence that the item resolves no clauses."}):(0,e.jsxs)(e.Fragment,{children:[u>0?(0,e.jsxs)("div",{"data-testid":"wi-behavior-contract-stale",children:[(0,e.jsxs)("div",{className:"det-label",children:["⚠ ",u," coverage claim(s) pinned to a SUPERSEDED revision — advisory, nothing enforces this yet"]}),n.groups.flatMap(m=>m.staleEdges.map(v=>(0,e.jsxs)("div",{children:["• ",m.planSlug," / ",v.specId,": proof at r",v.edgeRevision,", clause now r",v.currentRevision]},`${m.planSlug}:${v.specId}`)))]}):null,n.groups.length===0?(0,e.jsxs)("div",{className:"det-label",children:["This item resolves no behavior clauses.",n.stampedPlanSlug?` Its plan lane (${n.stampedPlanSlug}) has none linked.`:" It is standalone — link one with plans:set-spec-evidence."]}):n.groups.map(m=>(0,e.jsxs)("div",{children:[(0,e.jsxs)("div",{className:"det-label",children:[m.planSlug,m.planSlug===n.stampedPlanSlug?" (own plan)":""," · via"," ",m.via]}),m.clauses.map(v=>(0,e.jsxs)("div",{children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("strong",{children:[v.specId,"@r",v.revision]})," ","· ",v.lifecycleStatus,v.enforceable?"":" (not enforceable)"," · ",v.behaviorClass,v.mutationRequired?" · mutation-required":""]}),(0,e.jsx)("div",{children:v.behavior}),(0,e.jsx)("div",{className:"det-label",children:v.falsifier?`Falsified by: ${v.falsifier.observation}${v.falsifier.probeMethod?` (probe: ${v.falsifier.probeMethod})`:""}`:"No falsifier declared (D-016 gap — not a passing clause)"})]},`${m.planSlug}:${v.specId}`))]},m.planSlug)),n.impact?.report?(0,e.jsxs)("div",{"data-testid":"wi-behavior-contract-impact",children:[(0,e.jsx)("div",{className:"det-label",children:"Advisory — reported, not enforced"}),(0,e.jsx)("div",{children:n.impact.report})]}):null,n.impact&&!n.impact.required?(0,e.jsx)("div",{className:"det-label",children:n.impact.reason==="observation-lane"?"Observation-lane item — a candidate input, never enforceable (D-012).":"Not a behavior-changing kind, so no clause resolution is required."}):null]})}):null]})}var dt="wisa";function ct({slug:a,workItem:t}){const[i,r]=F(dt,W),h=(0,d.useMemo)(()=>V(i),[i]),o=h.id===t.id&&(!h.harness||h.harness===a),s=A({queryName:"workItems.specAdequacy",args:{harnessSlug:a,workItemId:t.id},enabled:o&&!!a&&!!t.id}),n=s.loading?null:s.data?.[0]??null;return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("div",{className:"pc-adv-detail__section",children:(0,e.jsx)("div",{className:"pc-adv-detail__actions",children:(0,e.jsxs)("button",{type:"button","data-testid":"wi-detail-spec-adequacy","aria-expanded":o,"aria-controls":`work-item-spec-adequacy-${t.id}`,onClick:()=>{r(o?null:J(a,t.id))},children:["Close gate",n?.verdict.applicable?` (${n.clauses.length})`:""]})})}),o?(0,e.jsx)("div",{id:`work-item-spec-adequacy-${t.id}`,className:"pc-adv-detail__section",children:s.loading?(0,e.jsx)("div",{className:"det-label",children:"Running the close gate…"}):!n||n.unavailableReason?(0,e.jsx)("div",{className:"det-label","data-testid":"wi-spec-adequacy-unavailable",children:n?.unavailableReason==="work-item-not-found"?"Work item not found in this harness.":"Close gate unavailable (the gate errored). This is NOT evidence that the close is clear."}):n.verdict.applicable?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"det-label",children:["Rubric: ",(0,e.jsx)("strong",{children:n.rubricRef}),n.classRef?` · graded as ${n.classRef}`:" · no plan class supplied"]}),n.verdictIsLowerBound?(0,e.jsx)("div",{className:"det-label","data-testid":"wi-spec-adequacy-lower-bound",children:"ⓘ Lower bound: a read cannot attest working-tree fingerprints, so freshness reads as UNESTABLISHED rather than failed. Supplying the attestation at close time can only move a clause toward passing."}):null,n.verdict.blockerReason?(0,e.jsxs)("div",{"data-testid":"wi-spec-adequacy-blocker",children:[(0,e.jsx)("div",{className:"det-label",children:"Would block the close — exact gate text, verbatim:"}),(0,e.jsx)("div",{children:n.verdict.blockerReason})]}):(0,e.jsxs)("div",{className:"det-label","data-testid":"wi-spec-adequacy-clear",children:["No blocker at this reading",n.verdict.checked.length?` · accepted: ${n.verdict.checked.join(", ")}`:""]}),n.clauses.length?(0,e.jsxs)("div",{children:[(0,e.jsx)("div",{className:"det-label",children:"Enforced clauses and their proof floor"}),n.clauses.map(u=>(0,e.jsxs)("div",{children:[(0,e.jsxs)("strong",{children:[u.specId,"@r",u.revision]})," ","· ",u.behaviorClass,u.mutationRequired?" · mutation-required":""," ·"," ",u.requiredProofFloor?`floor ${u.requiredProofFloor.toUpperCase()}`:"floor depends on the plan class (none supplied)",u.requiredTestLayers.length?` · layers ${u.requiredTestLayers.join(", ")}`:""]},u.specId))]}):null,n.verdict.impactReport?(0,e.jsxs)("div",{"data-testid":"wi-spec-adequacy-impact",children:[(0,e.jsx)("div",{className:"det-label",children:"Advisory — reported, not enforced"}),(0,e.jsx)("div",{children:n.verdict.impactReport})]}):null]}):(0,e.jsx)("div",{className:"det-label","data-testid":"wi-spec-adequacy-inapplicable",children:"The spec-test-adequacy gate does not apply to this item — it resolves no enforceable clause that requires proof."})}):null]})}function ce({title:a,records:t}){return(0,e.jsxs)("div",{children:[(0,e.jsx)("div",{className:"det-label",children:a}),t.map(i=>(0,e.jsxs)("div",{children:[(0,e.jsxs)("div",{children:[(0,e.jsx)("strong",{children:i.authority})," · ",i.scope,i.at?` · ${i.at}`:""]}),(0,e.jsxs)("div",{children:[i.text,i.textTruncated?(0,e.jsxs)("em",{children:[" ","[…clipped",i.fullTextChars?` from ${i.fullTextChars} chars`:""," — resolve ",i.rawRef," for the full text]"]}):null]})]},i.rawRef))]})}function G({onBack:a}){return a?(0,e.jsx)(O,{label:"Back to previous selection",children:(0,e.jsx)("button",{type:"button",className:"pc-adv-detail__back",onClick:a,children:"← Back"})}):null}function pt({slug:a,feature:t,issues:i,runs:r,onSelect:h,onBack:o,patchFeature:s,isEditing:n,onStartEdit:u,onCloseEdit:m}){const v=ee(),[l,c]=(0,d.useState)(null),[g,f]=(0,d.useState)(null),[b,j]=(0,d.useState)(!1),[w,z]=(0,d.useState)(""),{confirm:k,element:E}=pe(),T=A({queryName:"featureNotes.byHarness",args:{harnessSlug:a},enabled:!!a,staleTime:3e4}),R=T.data?.find(p=>p.featureId===t.id),q=(0,d.useCallback)(async()=>{const p=w.trim();if(p){c("steer");try{const _=await fetch(`/api/harness/${encodeURIComponent(a)}/features/${encodeURIComponent(t.id)}/notes`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({content:p})});if(!_.ok)throw new Error(`${_.status}: ${await _.text()}`);f(y=>[...y??[],p]),T.invalidate(),z(""),j(!0),S.toast.success("Steer note added")}catch(_){S.toast.error("Add steer note failed",{description:String(_)})}finally{c(null)}}},[t.id,T,a,w]),$=(0,d.useMemo)(()=>i.filter(p=>p.linkedFeatureId===t.id||p.foundDuring===t.id),[i,t.id]),C=(0,d.useMemo)(()=>r.filter(p=>p.featureId===t.id).sort((p,_)=>Date.parse(String(_.ts))-Date.parse(String(p.ts))).slice(0,3),[r,t.id]);(0,d.useEffect)(()=>{if(T.loading){f(null);return}f(Ze(R?.content??""))},[T.loading,R?.content]);const D=(0,d.useCallback)(async(p,_)=>{const y=await fetch(`/api/harness/${encodeURIComponent(a)}${p}`,_);if(!y.ok)throw new Error(`${y.status}: ${await y.text()}`);return y.json()},[a]),P=(0,d.useCallback)(async p=>{const _=t.status;s(t.id,{status:p}),c(`status:${p}`);try{await D(`/features/${t.id}?phase=staging`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:p})}),S.toast.success(`${t.id} → ${p}`)}catch(y){s(t.id,{status:_}),S.toast.error("Status change failed",{description:String(y)})}finally{c(null)}},[D,t.id,t.status,s]),B=(0,d.useCallback)(async()=>{if(!await k({title:`Reset ${t.id}?`,body:`Reset ${t.id} back to open and clear its attempts. The worker will pick it up fresh.`,destructive:!0,confirmLabel:"Reset"}))return;const p={status:t.status,attempts:t.attempts};s(t.id,{status:"open",attempts:0}),c("reset");try{await D(`/features/${t.id}/reset?phase=staging`,{method:"POST"}),S.toast.success(`${t.id} reset`)}catch(_){s(t.id,p),S.toast.error("Reset failed",{description:String(_)})}finally{c(null)}},[D,t.id,t.status,t.attempts,s,k]);return n?(0,e.jsx)(We,{embedded:!0,slug:a,feature:{id:t.id,title:t.title,claims:t.claims,status:t.status,attempts:t.attempts??0},onClose:m,onSaved:()=>{}}):(0,e.jsxs)("div",{className:"pc-adv-detail",children:[(0,e.jsxs)("header",{className:"pc-adv-detail__header",children:[(0,e.jsx)(G,{onBack:o}),(0,e.jsx)("div",{className:"pc-adv-detail__id",children:t.id}),(0,e.jsx)("div",{className:"pc-adv-detail__title",children:t.title}),(0,e.jsxs)("div",{className:"pc-adv-detail__meta",children:[(0,e.jsx)(X,{status:t.status}),typeof t.attempts=="number"&&t.attempts>0&&(0,e.jsxs)("span",{className:"pc-adv-detail__attempts",children:[t.attempts,"× attempts"]}),t.sourcePlanSlug&&(0,e.jsx)(O,{label:`From plan: ${t.sourcePlanSlug}`,children:(0,e.jsxs)("span",{className:"pc-adv-detail__plan",children:["↗ ",t.sourcePlanSlug]})})]})]}),(0,e.jsxs)("section",{className:"pc-adv-detail__body",children:[(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Description"}),t.summary?(0,e.jsx)("p",{className:"pc-adv-detail__prose",children:t.summary}):(0,e.jsx)("p",{className:"pc-adv-detail__muted",children:"No description."})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Status"}),(0,e.jsx)("div",{className:"pc-adv-detail__status-row",children:(0,e.jsx)(ve,{value:t.status,onChange:p=>{P(p)},disabled:l!==null,ariaLabel:"Change status",triggerClassName:"pc-adv-detail__select",options:Qe.map(p=>({value:p,label:(0,e.jsx)(X,{status:p,size:"xs"})}))})})]}),$.length>0&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsxs)("h3",{children:["Issues (",$.length,")"]}),(0,e.jsx)("div",{className:"pc-adv-detail__related",children:$.map(p=>(0,e.jsx)(O,{label:p.title,children:(0,e.jsxs)("button",{type:"button",className:"pc-adv-detail__related-row",onClick:()=>h(p.id),children:[(0,e.jsx)("span",{className:"pc-adv-detail__related-id",children:p.id}),(0,e.jsx)("span",{className:"pc-adv-detail__related-dot",style:{background:De[p.severity].solid}}),(0,e.jsx)("span",{className:"pc-adv-detail__related-title",children:p.title})]})},p.id))})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Recent activity"}),C.length===0?(0,e.jsx)("p",{className:"pc-adv-detail__muted",children:"No agent runs for this feature yet."}):(0,e.jsx)("div",{className:"pc-adv-detail__runs",children:C.map(p=>{const _=Ge(p);return(0,e.jsxs)("div",{className:"pc-adv-detail__run-block",children:[(0,e.jsxs)("div",{className:"pc-adv-detail__run",children:[(0,e.jsx)("span",{className:"pc-adv-detail__run-role",children:Fe(p.role,v)}),(0,e.jsx)("span",{className:"pc-adv-detail__run-time",children:te(p.ts)}),(0,e.jsxs)("span",{className:"pc-adv-detail__run-right",children:[p.costUsd!=null&&Number(p.costUsd)>0&&(0,e.jsxs)("span",{className:"pc-adv-detail__run-cost",children:["$",Number(p.costUsd).toFixed(2)]}),_&&(0,e.jsx)("span",{className:`pc-adv-detail__run-outcome is-${_.kind}`,title:_.detail,children:_.label}),p.sessionId&&(0,e.jsx)(O,{label:"Open this run's agent session in a terminal (claude --resume)",children:(0,e.jsx)("button",{type:"button",className:"pc-adv-detail__run-open",onClick:()=>{Xe(a,p.sessionId)},children:"Open session"})})]})]}),_?.kind==="failed"&&_.detail&&(0,e.jsx)("div",{className:"pc-adv-detail__run-error",title:_.detail,children:_.detail})]},p.runId)})})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:(0,e.jsxs)("button",{type:"button",className:"pc-adv-detail__collapse",onClick:()=>j(p=>!p),children:[b?"▾":"▸"," Steer notes",g&&g.length>0?` (${g.length})`:""]})}),b&&(0,e.jsxs)(e.Fragment,{children:[g&&g.length>0&&(0,e.jsx)("div",{className:"pc-adv-detail__notes",children:g.map((p,_)=>(0,e.jsx)("p",{className:"pc-adv-detail__note",children:p},_))}),(0,e.jsxs)("div",{className:"pc-adv-detail__note-form",children:[(0,e.jsx)("textarea",{value:w,onChange:p=>z(p.target.value),placeholder:"Add a steer note for the worker…",rows:2,"aria-label":"Add a steer note"}),(0,e.jsx)("button",{type:"button",disabled:l!==null||!w.trim(),onClick:()=>{q()},children:"Add steer note"})]})]})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Actions"}),(0,e.jsxs)("div",{className:"pc-adv-detail__actions",children:[(0,e.jsxs)("button",{type:"button",disabled:l!==null,onClick:async()=>{c("chat");try{const p=await ge({slug:a,role:"worker",featureId:t.id,title:t.summary||t.title,mode:"discuss"});if(p&&typeof p=="object"&&"error"in p)throw new Error(String(p.error))}catch(p){S.toast.error("Open chat failed",{description:String(p)})}finally{c(null)}},children:[(0,e.jsx)(Z,{size:13,"aria-hidden":!0})," Chat"]}),(0,e.jsx)("button",{type:"button",disabled:l!==null,onClick:B,children:"Reset"}),(0,e.jsx)("button",{type:"button",disabled:l!==null,onClick:u,children:"Edit"})]})]})]}),E,(0,e.jsx)(Y,{})]})}function ut({slug:a,issue:t,onSelect:i,onBack:r,patchIssue:h}){const[o,s]=(0,d.useState)(null),[n,u]=(0,d.useState)(""),[m,v]=(0,d.useState)([]);(0,d.useEffect)(()=>{v([])},[t.id]);const l=(0,d.useMemo)(()=>[...t.notes??[],...m],[t.notes,m]),c=(0,d.useCallback)(async f=>{const b=xe(f),j=t.status;b&&h(t.id,{status:b}),s(f);try{await Ve(a,t.id,f),S.toast.success(`${t.id} → ${f}`)}catch(w){b&&h(t.id,{status:j}),S.toast.error(`${f} failed`,{description:String(w)})}finally{s(null)}},[a,t.id,t.status,h]),g=(0,d.useCallback)(async()=>{const f=n.trim();if(f){s("note");try{const b=await fetch(`/api/harness/${encodeURIComponent(a)}/issues/${encodeURIComponent(t.id)}/update`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({note:f,by:"human"})});if(!b.ok)throw new Error(`${b.status}: ${await b.text()}`);v(j=>[...j,{ts:new Date().toISOString(),by:"human",text:f}]),u(""),S.toast.success("Note added")}catch(b){S.toast.error("Add note failed",{description:String(b)})}finally{s(null)}}},[a,t.id,n]);return(0,e.jsxs)("div",{className:"pc-adv-detail",children:[(0,e.jsxs)("header",{className:"pc-adv-detail__header",children:[(0,e.jsx)(G,{onBack:r}),(0,e.jsx)("div",{className:"pc-adv-detail__id",children:t.id}),(0,e.jsx)("div",{className:"pc-adv-detail__title",children:t.title}),(0,e.jsxs)("div",{className:"pc-adv-detail__meta",children:[(0,e.jsx)(me,{severity:t.severity}),(0,e.jsx)(he,{status:t.status}),t.linkedFeatureId&&(0,e.jsx)(O,{label:`Go to linked feature ${t.linkedFeatureId}`,children:(0,e.jsxs)("button",{type:"button",className:"pc-adv-detail__link pc-adv-detail__link-btn",onClick:()=>i(t.linkedFeatureId),children:[(0,e.jsx)(ue,{size:11,"aria-hidden":!0})," ",t.linkedFeatureId]})})]})]}),(0,e.jsxs)("section",{className:"pc-adv-detail__body",children:[t.evidence&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Evidence"}),(0,e.jsx)("pre",{className:"pc-adv-detail__code",children:t.evidence})]}),t.repro&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Reproduction"}),(0,e.jsx)("pre",{className:"pc-adv-detail__code",children:t.repro})]}),t.suggestedFix&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Suggested fix"}),(0,e.jsx)("pre",{className:"pc-adv-detail__code",children:t.suggestedFix})]}),t.codePointer&&(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Code pointer"}),(0,e.jsx)("code",{className:"pc-adv-detail__pointer",children:t.codePointer})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsxs)("h3",{children:["Notes",l.length>0?` (${l.length})`:""]}),l.length>0&&(0,e.jsx)("div",{className:"pc-adv-detail__notes",children:l.map((f,b)=>(0,e.jsxs)("div",{className:"pc-adv-detail__note-row",children:[(0,e.jsxs)("div",{className:"pc-adv-detail__note-meta",children:[f.by," · ",f.ts?new Date(f.ts).toLocaleString():""]}),(0,e.jsx)("p",{className:"pc-adv-detail__note",children:f.text})]},b))}),(0,e.jsxs)("div",{className:"pc-adv-detail__note-form",children:[(0,e.jsx)("textarea",{value:n,onChange:f=>u(f.target.value),placeholder:"Add a note…",rows:2,"aria-label":"Add a note"}),(0,e.jsx)("button",{type:"button",disabled:o!==null||!n.trim(),onClick:()=>{g()},children:"Add note"})]})]}),(0,e.jsxs)("div",{className:"pc-adv-detail__section",children:[(0,e.jsx)("h3",{children:"Actions"}),(0,e.jsxs)("div",{className:"pc-adv-detail__actions",children:[!t.linkedFeatureId&&t.status!=="closed"&&t.status!=="wontfix"&&(0,e.jsx)("button",{type:"button",disabled:o!==null,onClick:()=>{c("promote")},children:"Promote"}),t.status!=="acknowledged"&&t.status!=="closed"&&(0,e.jsx)("button",{type:"button",disabled:o!==null,onClick:()=>{c("acknowledge")},children:"Acknowledge"}),t.status!=="closed"&&(0,e.jsx)("button",{type:"button",disabled:o!==null,onClick:()=>{c("close")},children:"Close"}),t.status!=="wontfix"&&(0,e.jsx)("button",{type:"button",disabled:o!==null,onClick:()=>{c("wontfix")},children:"Won't fix"})]})]})]}),(0,e.jsx)(Y,{})]})}function U({children:a,tone:t}){return(0,e.jsx)("div",{className:`pc-adv-detail__empty${t==="error"?" pc-adv-detail__empty--error":""}`,style:{height:"100%",display:"grid",placeItems:"center",padding:24,color:t==="error"?"var(--bad, #fb7185)":"var(--fg-mute, #7f9bb4)",fontSize:13,textAlign:"center"},children:a})}function Y(){return(0,e.jsx)("style",{children:`
      .pc-adv-detail {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg-1, #0b1220);
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-adv-detail__header {
        flex-shrink: 0;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
      }
      .pc-adv-detail__back {
        display: inline-flex;
        align-items: center;
        margin-bottom: 8px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-adv-detail__back:hover {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: var(--fg-mute, #7f9bb4);
        letter-spacing: 0;
      }
      .pc-adv-detail__title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--fg, #e7f7ff);
        margin-top: 4px;
      }
      .pc-adv-detail__meta {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__attempts {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
        white-space: nowrap;
      }
      .pc-adv-detail__plan,
      .pc-adv-detail__link {
        font-size: 11px;
        color: var(--accent-strong, #7dd3fc);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .pc-adv-detail__link-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .pc-adv-detail__link-btn:hover {
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__body {
        flex: 1;
        overflow: auto;
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      /* The status Select's simple row container. */
      .pc-adv-detail__status-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      /* Label / value field rows (WorkItemDetail) — previously unstyled:
         the spans rendered run-together inline. */
      .pc-adv-detail__field-row {
        display: grid;
        grid-template-columns: 88px 1fr;
        gap: 12px;
        align-items: baseline;
        padding: 3px 0;
        font-size: 12.5px;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__field-label {
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      /* Hairline rhythm between stacked sections — scannability without cards. */
      .pc-adv-detail__section + .pc-adv-detail__section {
        border-top: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 45%);
        padding-top: 14px;
      }
      .pc-adv-detail__section h3 {
        margin: 0 0 6px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__collapse {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
        cursor: pointer;
      }
      .pc-adv-detail__prose {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__muted {
        margin: 0;
        font-size: 12px;
        font-style: italic;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      /* AgentDetail furniture — liveness line, warning chips, queue + claims. */
      .pc-adv-detail__liveness {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .pc-adv-detail__warn-chip {
        font-size: 10.5px;
        font-weight: 700;
        padding: 1px 8px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        color: color-mix(in oklab, var(--warn, #fbbf24), white 35%);
        white-space: nowrap;
        cursor: default;
      }
      .pc-adv-detail__queue {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .pc-adv-detail__queue-chip {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        color: var(--fg-dim, #b9d4e8);
        cursor: pointer;
      }
      .pc-adv-detail__queue-chip:hover:not(:disabled) {
        border-color: var(--accent, #38bdf8);
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__queue-chip:disabled {
        cursor: default;
        opacity: 0.7;
      }
      .pc-adv-detail__claim-row {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px;
        align-items: baseline;
        font-size: 12px;
        padding: 2px 0;
      }
      .pc-adv-detail__claim-type {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related-row {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px;
        align-items: center;
        padding: 5px 8px;
        font-size: 12px;
        text-align: left;
        color: var(--fg-dim, #b9d4e8);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__related-row:hover:not(:disabled) {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
      }
      .pc-adv-detail__related-row:disabled {
        cursor: default;
      }
      .pc-adv-detail__related-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .pc-adv-detail__related-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__runs {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-adv-detail__run {
        display: flex;
        gap: 10px;
        align-items: baseline;
        font-size: 12px;
      }
      .pc-adv-detail__run-role {
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        min-width: 80px;
      }
      .pc-adv-detail__run-time {
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-right {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
        align-items: baseline;
      }
      .pc-adv-detail__run-cost {
        color: var(--fg-mute, #7f9bb4);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* P-023 outcome chip — colour buckets from runOutcome(). */
      .pc-adv-detail__run-outcome {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0;
        padding: 1px 7px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .pc-adv-detail__run-outcome.is-done {
        background: color-mix(in oklab, var(--good, #34d399), transparent 84%);
        color: color-mix(in oklab, var(--good, #34d399), white 35%);
      }
      .pc-adv-detail__run-outcome.is-failed {
        background: color-mix(in oklab, var(--bad, #f87171), transparent 82%);
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
      }
      .pc-adv-detail__run-outcome.is-cancelled {
        background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        color: color-mix(in oklab, var(--warn, #fbbf24), white 35%);
      }
      .pc-adv-detail__run-outcome.is-running {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-adv-detail__run-outcome.is-muted {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-open {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 999px;
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 60%);
        color: var(--accent-strong, #7dd3fc);
        cursor: pointer;
        white-space: nowrap;
      }
      .pc-adv-detail__run-open:hover {
        background: color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 86%);
      }
      .pc-adv-detail__run-error {
        margin: 1px 0 2px 90px;
        font-size: 11px;
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-adv-detail__notes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .pc-adv-detail__note-row {
        border-left: 2px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        padding-left: 10px;
      }
      .pc-adv-detail__note-meta {
        font-size: 10px;
        color: var(--fg-mute, #7f9bb4);
        margin-bottom: 2px;
      }
      .pc-adv-detail__note {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__note-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
      }
      .pc-adv-detail__note-form textarea {
        width: 100%;
        resize: vertical;
        padding: 6px 8px;
        font: inherit;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
      }
      .pc-adv-detail__note-form textarea:focus {
        outline: none;
        border-color: var(--accent, #38bdf8);
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
      }
      .pc-adv-detail__note-form button {
        align-self: flex-start;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__note-form button:hover:not(:disabled) {
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__note-form button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .pc-adv-detail__code {
        margin: 0;
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        color: var(--fg, #e7f7ff);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 240px;
        overflow: auto;
      }
      .pc-adv-detail__pointer {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        padding: 3px 8px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border-radius: 4px;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__select {
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 160px;
        min-height: 32px;
        padding: 0 10px;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__actions button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions button:hover:not(:disabled) {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__actions button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      /* Inline header stats (AgentDetail meta line: drive / load). */
      .pc-adv-detail__stat {
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
        white-space: nowrap;
      }
      /* Compact density variant — the working tab's agent:* / WI-* details.
         Same vocabulary, tighter rhythm: id+title share a line, the field
         rows flow 2-up when the pane is wide enough, smaller paddings. */
      .pc-adv-detail--compact .pc-adv-detail__header {
        padding: 8px 12px 7px;
      }
      .pc-adv-detail--compact .pc-adv-detail__back {
        margin-bottom: 4px;
      }
      .pc-adv-detail--compact .pc-adv-detail__id {
        display: inline;
      }
      .pc-adv-detail--compact .pc-adv-detail__title {
        display: inline;
        margin: 0 0 0 7px;
        font-size: 13px;
        line-height: 1.35;
      }
      .pc-adv-detail--compact .pc-adv-detail__meta {
        margin-top: 5px;
        gap: 6px;
      }
      .pc-adv-detail--compact .pc-adv-detail__body {
        padding: 10px 12px;
        gap: 10px;
      }
      .pc-adv-detail--compact .pc-adv-detail__section + .pc-adv-detail__section {
        padding-top: 9px;
      }
      .pc-adv-detail--compact .pc-adv-detail__section h3 {
        margin-bottom: 4px;
      }
      .pc-adv-detail--compact .pc-adv-detail__fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        column-gap: 18px;
      }
      .pc-adv-detail--compact .pc-adv-detail__field-row {
        grid-template-columns: 64px 1fr;
        gap: 8px;
        padding: 1.5px 0;
        font-size: 12px;
      }
      .pc-adv-detail--compact .pc-adv-detail__prose {
        font-size: 12px;
        line-height: 1.45;
      }
      .pc-adv-detail--compact .pc-adv-detail__related-row {
        padding: 3px 6px;
      }
      .pc-adv-detail--compact .pc-adv-detail__actions button {
        padding: 4px 10px;
      }
    `})}export{qt as a,zt as i,at as n,ie as o,Ye as r,ge as s,Mt as t};
