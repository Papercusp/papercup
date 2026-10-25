import{o as ca}from"./chunk-a1a4177d.js";import{t as da}from"./react-ea1d8b8b.js";import{t as la}from"./jsx-runtime-660d4162.js";import{t as ge}from"./RichGrid-3007da6f.js";import{t as le}from"./esm-a8c010cf.js";import{a as pa,n as va,t as ha}from"./filters-844488db.js";import{t as ua}from"./dist-54e97c5e.js";import{i as q}from"./SyncContext-10c8fc40.js";import{l as I,n as fa,o as R,s as ie,u as pe}from"./dist-8935d6c3.js";import{t as _a}from"./arrow-left-e240fe09.js";import{t as qe}from"./arrow-up-right-346a70f8.js";import{t as fe}from"./bot-474110a5.js";import{t as We}from"./circle-check-df066ec8.js";import{t as Re}from"./inbox-cef1e192.js";import{t as Ie}from"./megaphone-4031bae3.js";import{t as J}from"./message-circle-23cdbc08.js";import{t as _e}from"./messages-square-3c8a2aa0.js";import{t as xa}from"./plus-158d6eda.js";import{t as Te}from"./radio-b9d73551.js";import{t as X}from"./refresh-cw-d4dbdc1a.js";import{t as Ue}from"./search-44920aa8.js";import{t as xe}from"./send-1597fdae.js";import{t as ma}from"./sliders-horizontal-165fbad3.js";import{t as ga}from"./triangle-alert-9e927429.js";import{t as He}from"./user-round-ff4ed52a.js";import{t as re}from"./Tooltip-98086d04.js";import{r as Qe,t as Ge}from"./list-meta-e0de96bd.js";import{c as oe,s as se}from"./theme-7f2f666e.js";import{a as ba,t as wa}from"./ChatPanel-91d039a2.js";import{a as F,d as Je,n as Ye,o as Ze,s as ze,t as M,u as be}from"./picker-kit-f6605296.js";import{t as V}from"./pot-label-e96b7cbc.js";import{c as ya,d as ja,f as ka,i as Na,l as Sa,m as Ca,n as za,o as Ra,r as Ta,u as $n}from"./unified-conversations-c7a4c7f2.js";import{i as Oe,n as me,r as Y,t as Aa}from"./AuthoredFields-96914ed2.js";import{n as Ia}from"./AskComposer-35c1e8e6.js";/* empty css                         */var p=ca(da(),1),Oa=ua(),e=la(),B=100,Ea=B*4,Xe=108,Ma=8e3,Da=Ra,Z=Sa,La=ya,ce=Na;function ee({rows:a=4,label:d="Loading"}){return(0,e.jsx)("div",{className:"pc-advconv__skeleton",role:"status","aria-label":d,children:Array.from({length:a},(s,w)=>(0,e.jsx)("span",{className:"pc-advconv__skeleton-row","aria-hidden":!0},w))})}function de({message:a,onRetry:d}){return(0,e.jsxs)(Ye,{children:[(0,e.jsx)("span",{style:{display:"block",fontWeight:600},children:"Couldn't load"}),(0,e.jsx)("span",{children:Ze(void 0,a)}),(0,e.jsxs)("button",{type:"button",className:"pc-coord__chip pc-advconv__retry",onClick:d,style:{marginLeft:8},children:[(0,e.jsx)(X,{size:11,"aria-hidden":!0})," Retry"]})]})}var we=()=>"transparent",$a={style:{borderBottom:"none",paddingBottom:6}},qa={style:{borderBottom:"none",paddingBottom:5}},Ee=()=>$a,Fa=()=>qa,ve={conv:ie(["inbox","threads","deliberations","agentchats","messages","feed"]).withDefault("inbox"),conversation:R,thread:R,chat:R,cmsg:R,fmsg:R},he={conversation:null,thread:null,chat:null,cmsg:null,fmsg:null},Me=[{id:"inbox",label:"Conversations",desc:"Every curated conversation, ordered by the most recent activity.",group:"curated",Icon:Re},{id:"threads",label:"Questions & discussions",desc:"Questions and discussions between you and the agents.",group:"curated",Icon:J},{id:"deliberations",label:"Group decisions",desc:"Coord threads, proposals, and votes.",group:"curated",Icon:_e},{id:"agentchats",label:"Agent chat",desc:"An agent's full multi-turn transcript.",group:"curated",Icon:fe},{id:"messages",label:"Agent messages",desc:"Agent-to-agent coord:send traffic — who told whom what, with the reply chain.",group:"curated",Icon:xe},{id:"feed",label:"Raw events",desc:"The system message log — system-origin coordination (watchdog, routines, infra), newest first. The diagnostic traffic the curated conversations filter out.",group:"raw",Icon:Te}],Pa=Me.filter(a=>a.id==="inbox"),Ba=Me.filter(a=>a.group==="raw"),Ka={inbox:"var(--accent)",threads:"var(--accent)",deliberations:"var(--accent)",agentchats:"var(--accent)",messages:"var(--accent)",feed:"var(--fg-mute)"};function ye({row:a,label:d}){return(0,e.jsxs)("article",{className:"pc-coord__card pc-advconv__detail-loading","aria-busy":"true",children:[a?(0,e.jsx)("header",{className:"pc-advconv__detailhead",children:(0,e.jsxs)("div",{children:[(0,e.jsxs)("p",{className:"pc-advconv__detailkicker",children:[(0,e.jsx)("span",{className:`pc-advconv__unified-kind pc-advconv__unified-kind--${a.source}`,children:a.typeLabel}),a.state?(0,e.jsx)("span",{className:`pc-advconv__statepill pc-advconv__statepill--${a.state}`,children:a.state}):null]}),(0,e.jsx)("h2",{children:a.title})]})}):null,(0,e.jsx)(ee,{rows:4,label:d})]})}var Va=new Map(Me.map(a=>[a.id,a])),Wa=[{key:"type",header:"Type",filter:{type:"enum",accessor:a=>a.typeLabel}},{key:"state",header:"State",filter:{type:"enum",accessor:a=>a.state||null}},{key:"sender",header:"Sender",filter:{type:"enum",accessor:a=>a.actor??null}},{key:"recipient",header:"Recipient",filter:{type:"enum",accessor:a=>a.recipient??null}},{key:"pot",header:"Pot",filter:{type:"enum",accessor:a=>a.harnessSlug??null}},{key:"related",header:"Related work",filter:{type:"enum",accessor:a=>a.relatedRef??null}}];function Ua(){const[a,d]=pe(ve),[s,w]=I("cq",R.withDefault("")),v=Je(s,300),g=q({queryName:"conversations.questionsList",args:{limit:B},staleTime:3e4}),c=q({queryName:"conversations.deliberationList",args:{limit:B},staleTime:3e4}),o=q({queryName:"conversations.agentChatList",args:{limit:B},staleTime:3e4}),m=q({queryName:"conversations.agentMessageList",args:{limit:B,q:v.trim()||void 0},staleTime:3e4}),b=(0,p.useMemo)(()=>Ta({questions:g.data??[],deliberations:c.data??[],agentChats:o.data??[],agentMessages:m.data??[]},Ea),[g.data,c.data,o.data,m.data]),_=(0,p.useMemo)(()=>({kind:"window",count:b.length,window:`the latest bounded conversation window (up to ${B.toLocaleString("en-US")} per source)`}),[b.length]),l=pa(Wa,b,{ns:"cv",countEvidence:_}),f=(0,p.useMemo)(()=>{const n=v.trim().toLocaleLowerCase();return n?l.rows.filter(x=>[x.typeLabel,x.kind,x.state,x.title,x.preview,x.actor,x.recipient,x.harnessSlug,x.relatedRef].some(D=>ja(D).includes(n))):l.rows},[l.rows,v]),i=l.hasActive||s.trim()!=="",y=[g,c,o,m],k=y.some(n=>n.loading),S=y.find(n=>n.error)?.error??null,T=()=>y.forEach(n=>n.invalidate()),h=ha(k&&b.length===0?{kind:"unknown",reason:"loading"}:i?{kind:"window",count:f.length,windowTotal:b.length,window:`the latest bounded conversation window (up to ${B.toLocaleString("en-US")} per source)`}:_,"conversation"),[C,O]=(0,p.useState)(!1);(0,p.useEffect)(()=>{if(!k||b.length>0){O(!1);return}const n=window.setTimeout(()=>O(!0),Ma);return()=>window.clearTimeout(n)},[k,b.length]);const $=(0,p.useRef)(null),t=le({count:f.length,getScrollElement:()=>$.current,estimateSize:()=>Xe,getItemKey:n=>f[n]?.id??n,overscan:10}),N=n=>d({conv:n.source,conversation:n.source==="threads"?n.sourceId:null,thread:n.source==="deliberations"?n.sourceId:null,chat:n.source==="agentchats"?n.sourceId:null,cmsg:n.source==="messages"?n.sourceId:null,fmsg:null}),z=a.conv==="threads"?a.conversation:a.conv==="deliberations"?a.thread:a.conv==="agentchats"?a.chat:a.conv==="messages"?a.cmsg:null,A=z?`${a.conv}:${z}`:null,E=A?b.find(n=>n.id===A):void 0,W=()=>d({conv:"inbox",...he}),K=a.conv==="threads"&&a.conversation?(0,e.jsx)(en,{detailOnly:!0,loadingSummary:E}):a.conv==="deliberations"&&a.thread?(0,e.jsx)(an,{detailOnly:!0,loadingSummary:E}):a.conv==="agentchats"&&a.chat?(0,e.jsx)(nn,{detailOnly:!0,loadingSummary:E}):a.conv==="messages"&&a.cmsg?(0,e.jsx)(tn,{detailOnly:!0,loadingSummary:E}):(0,e.jsx)("section",{className:"pc-coord__detail",children:(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(Re,{size:22,"aria-hidden":!0}),title:"Select a conversation",desc:"Open a conversation to review its full context."})});return(0,e.jsx)(ae,{detailOpen:A!=null,onBack:A?()=>{W()}:void 0,filters:(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-advconv__railhead pc-advconv__railhead--unified",children:[(0,e.jsx)("span",{style:be,children:"Conversations"}),(0,e.jsx)("strong",{"aria-label":h.ariaLabel,children:h.title}),(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advconv__refresh","aria-label":"Reload conversations",disabled:k&&!C,onClick:()=>{O(!1),T()},children:(0,e.jsx)(X,{size:11,"aria-hidden":!0})})]}),(0,e.jsxs)("div",{className:"pc-advconv__unified-tools",children:[(0,e.jsxs)("label",{className:"pc-advconv__unified-search",children:[(0,e.jsx)(Ue,{size:13,"aria-hidden":!0}),(0,e.jsx)("input",{type:"search",value:s,onChange:n=>{w(n.target.value)},placeholder:"Search conversations…","aria-label":"Search conversations"})]}),(0,e.jsx)(va,{layout:"facets",controller:l.controller,activeChips:l.activeChips,hasActive:l.hasActive,clearAll:l.clearAll}),i?(0,e.jsx)("button",{type:"button",className:"pc-advpanel__chip pc-advconv__unified-reset",onClick:()=>{l.clearAll(),w("")},children:"Reset"}):null]})]}),list:(0,e.jsx)("div",{className:"pc-advconv__listscroll pc-advconv__unified",ref:$,children:k&&b.length===0&&!C?(0,e.jsx)(ee,{rows:6,label:"Loading conversations"}):C&&b.length===0?(0,e.jsx)(de,{message:"Conversation sync timed out.",onRetry:()=>{O(!1),T()}}):S&&b.length===0?(0,e.jsx)(de,{message:ce(S),onRetry:()=>{T()}}):f.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(Re,{size:22,"aria-hidden":!0}),title:i?"No conversations match":"No conversations",desc:i?"Clear a filter or broaden the search.":"No curated communication is recorded."}):(0,e.jsx)("div",{className:"pc-advconv__virtual-list",style:{height:t.getTotalSize()},children:t.getVirtualItems().map(n=>{const x=f[n.index];if(!x)return null;const D=Va.get(x.source)?.Icon??J;return(0,e.jsxs)("button",{type:"button",className:`pc-advconv__unified-row${A===x.id?" is-active":""}`,"data-index":n.index,style:{top:n.start},"aria-label":`Open ${x.title}`,"aria-current":A===x.id?"true":void 0,onClick:()=>{N(x)},children:[(0,e.jsx)("span",{className:`pc-advconv__unified-source pc-advconv__unified-source--${x.source}`,"aria-hidden":!0,children:(0,e.jsx)(D,{size:14})}),(0,e.jsxs)("span",{className:"pc-advconv__unified-content",children:[(0,e.jsxs)("span",{className:"pc-advconv__unified-topline",children:[(0,e.jsx)("span",{className:`pc-advconv__unified-kind pc-advconv__unified-kind--${x.source}`,children:x.typeLabel}),x.state?(0,e.jsx)("span",{className:`pc-advconv__statepill pc-advconv__statepill--${x.state}`,children:x.state}):null,(0,e.jsx)("time",{children:La(x.updatedAt)})]}),(0,e.jsx)("strong",{children:x.title}),x.preview?(0,e.jsx)("span",{className:"pc-advconv__unified-preview",children:x.preview}):null,(0,e.jsxs)("span",{className:"pc-advconv__unified-meta",children:[x.actor?(0,e.jsx)("span",{children:x.actor}):null,x.recipient?(0,e.jsxs)("span",{children:["→ ",x.recipient]}):null,x.harnessSlug?(0,e.jsx)("span",{children:V(x.harnessSlug)}):null,x.relatedRef?(0,e.jsx)("span",{children:x.relatedRef}):null,x.count?(0,e.jsx)("span",{children:x.count}):null]})]})]},n.key)})})}),detail:K})}function ae({filters:a,list:d,detail:s,detailOpen:w=!1,onBack:v,detailOnly:g=!1}){const[c,o]=pe(ve),m=c.conv,[b,_]=(0,p.useState)(!1),l=i=>{const y=i===m;o({conv:i,...he,conversation:y&&i==="threads"?c.conversation:null,thread:y&&i==="deliberations"?c.thread:null,chat:y&&i==="agentchats"?c.chat:null,cmsg:y&&i==="messages"?c.cmsg:null,fmsg:y&&i==="feed"?c.fmsg:null})},f=i=>{const y=i.id==="inbox"?m!=="feed":m===i.id;return(0,e.jsx)(re,{label:i.desc,children:(0,e.jsxs)("button",{id:`adv-conversations-tab-${i.id}`,type:"button",role:"tab","aria-label":i.label,"aria-selected":y,"aria-controls":"adv-conversations-panel",className:`pc-advconv__navbtn pc-advconv__navbtn--${i.group}${y?" is-active":""}`,style:{"--nav-accent":Ka[i.id]},onClick:()=>l(i.id),children:[(0,e.jsx)("span",{className:"pc-advconv__navicon","aria-hidden":!0,children:(0,e.jsx)(i.Icon,{size:14})}),(0,e.jsx)("span",{className:"pc-advconv__navlabel",children:i.label})]})},i.id)};return g?(0,e.jsx)(e.Fragment,{children:s}):(0,e.jsxs)("div",{className:`pc-advconv__shell${w?" is-detail-open":""}`,children:[(0,e.jsx)("aside",{className:"pc-plans__rail pc-advconv__nav",children:(0,e.jsxs)("div",{className:"pc-plans__rail-actions pc-advconv__nav-actions",children:[(0,e.jsx)(re,{label:"Ask the agents a question — opens a question conversation routed to topic subscribers; answers land in Conversations.",children:(0,e.jsxs)("button",{type:"button",className:"pc-plans__new-plan",onClick:()=>_(!0),"aria-label":"Ask the agents",children:[(0,e.jsx)("span",{className:"pc-advconv__navicon","aria-hidden":!0,children:(0,e.jsx)(xa,{size:14})}),(0,e.jsx)("span",{className:"pc-advconv__navlabel",children:"Ask"})]})}),(0,e.jsxs)("div",{className:"pc-advconv__nav-switcher",role:"tablist","aria-label":"Conversations view",children:[(0,e.jsx)("div",{className:"pc-advconv__nav-primary",role:"presentation",children:Pa.map(f)}),(0,e.jsxs)("div",{className:"pc-advconv__nav-diagnostic",role:"presentation",children:[(0,e.jsx)("span",{className:"pc-advconv__nav-sep",role:"separator","aria-orientation":"horizontal"}),Ba.map(f)]})]})]})}),d!=null&&(0,e.jsxs)("section",{className:"pc-advconv__inbox","aria-label":"Conversation list",children:[a!=null&&(0,e.jsx)("div",{className:"pc-plans__group pc-advconv__navfilters",children:a}),(0,e.jsx)("div",{className:"pc-advconv__navlist",children:d})]}),(0,e.jsxs)("main",{id:"adv-conversations-panel",role:"tabpanel","aria-labelledby":`adv-conversations-tab-${m==="feed"?"feed":"inbox"}`,className:`pc-advconv__main${d==null?" pc-advconv__main--wide":""}`,children:[v?(0,e.jsx)(re,{label:"Back to conversations",children:(0,e.jsx)("button",{type:"button",className:"pc-advconv__back","aria-label":"Back to conversations",onClick:v,children:(0,e.jsx)(_a,{size:15,"aria-hidden":!0})})}):null,s]}),(0,e.jsx)(Ia,{open:b,onOpenChange:_,onAsked:()=>l("inbox")})]})}function Bn(){const[a,d]=pe(ve),s=a.conv==="threads"?a.conversation:a.conv==="deliberations"?a.thread:a.conv==="agentchats"?a.chat:a.conv==="messages"?a.cmsg:null,w=a.conv!=="inbox"&&a.conv!=="feed",v=w&&!s?"inbox":a.conv;return(0,p.useEffect)(()=>{!w||s||d({conv:"inbox",...he})},[w,s,d]),(0,e.jsxs)("div",{className:"pc-coord pc-advconv pc-advconv--shell",children:[v==="feed"?(0,e.jsx)(Za,{}):(0,e.jsx)(Ua,{}),(0,e.jsx)(rn,{})]})}var Ha=["message","ack","notify","broadcast","handoff","handoff_accepted","escalation","escalation_resolved","plan_event","subscribe","unsubscribe","contract"],Qa=[{id:"messages",label:"Messages",description:"Direct and broadcast messages",kinds:["message","broadcast"]},{id:"handoffs",label:"Handoffs",description:"Work passed between agents",kinds:["handoff"]},{id:"escalations",label:"Escalations",description:"Blocked work and resolutions",kinds:["escalation","escalation_resolved"]},{id:"plan-events",label:"Plan events",description:"Plan changes and lifecycle updates",kinds:["plan_event"]}];function Ga(a){const d=new Date(a);return Number.isNaN(d.getTime())?"unknown":d.toISOString().slice(0,10)}function Fe(a){if(a==="unknown")return"Unknown date";const d=new Date().toISOString().slice(0,10),s=new Date(Date.now()-864e5).toISOString().slice(0,10);return a===d?"Today":a===s?"Yesterday":new Date(`${a}T00:00:00Z`).toLocaleDateString(void 0,{weekday:"short",month:"short",day:"numeric"})}function Pe(a){const d=Date.parse(a);if(Number.isNaN(d))return"—";const s=Date.now()-d;if(s<0)return"just now";const w=Math.round(s/1e3);if(w<60)return`${w}s ago`;const v=Math.round(w/60);if(v<60)return`${v}m ago`;const g=Math.round(v/60);return g<24?`${g}h ago`:`${Math.round(g/24)}d ago`}function Ja(a){const d=new Date(a);return Number.isNaN(d.getTime())?"":d.toLocaleTimeString(void 0,{hour:"2-digit",minute:"2-digit"})}function Ae(a){if(!a)return"";const d=new Date(a);return Number.isNaN(d.getTime())?"":d.toLocaleDateString(void 0,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}function Ya({to:a,broadcast:d}){return d?(0,e.jsxs)("span",{className:"pc-advfeed__to pc-advfeed__to--broadcast",children:[(0,e.jsx)(Ie,{size:10,"aria-hidden":!0})," BROADCAST"]}):a.includes("human")?(0,e.jsxs)("span",{className:"pc-advfeed__to pc-advfeed__to--human",children:[(0,e.jsx)(He,{size:10,"aria-hidden":!0})," → human"]}):(0,e.jsxs)("span",{className:"pc-advfeed__to",children:["→ ",a.length?a.join(", "):"∅"]})}function Za(){const[a,d]=I("fkind",fa(R).withDefault([])),[s,w]=I("fadvanced",ie(["closed","open"]).withDefault("closed")),[v,g]=I("fagent",R.withDefault("")),[c,o]=I("fplan",R.withDefault("")),[m,b]=I("fq",R.withDefault("")),_=Je(m,300),[l,f]=I("fmsg",R),[i,y]=I("fsys",ie(["system","all"]).withDefault("system")),k=i!=="all",S=100,[T,h]=(0,p.useState)(S),C=a.includes("broadcast"),O=(0,p.useMemo)(()=>a.filter(r=>r!=="broadcast"),[a]),$=(0,p.useMemo)(()=>({...O.length?{kinds:O}:{},...v?{owner:v}:{},...c?{plan_slug:c}:{},..._.trim()?{q:_.trim()}:{},system_only:k,limit:T}),[O,v,c,_,k,T]),t=(0,p.useRef)(null);(0,p.useEffect)(()=>{t.current?.abort();const r=new AbortController;return t.current=r,()=>r.abort()},[$]);const N=q({queryName:"dev.coordFeed",args:$,staleTime:5e3});(0,p.useEffect)(()=>{h(S)},[(0,p.useMemo)(()=>JSON.stringify({kinds:a,agent:v,plan:c,q:_.trim(),scope:i}),[a,v,c,_,i])]);const z=N.data??[],A=z[0]?._meta,E=(0,p.useMemo)(()=>C?z.filter(r=>r.broadcast):z,[z,C]),W=(0,p.useMemo)(()=>{const r=A?.byKind??{};return{broadcastCount:z.filter(u=>u.broadcast).length,humanCount:z.filter(u=>(u.to??[]).includes("human")).length,escalationCount:r.escalation??z.filter(u=>u.kind==="escalation").length}},[A,z]),{roots:K,childrenOf:n,rootIdOf:x}=(0,p.useMemo)(()=>{const r=new Map(E.map(L=>[L.msg_id,L])),u=new Map,j=[];for(const L of E){const P=typeof L.related_msg_id=="string"?L.related_msg_id:null;if(P&&r.has(P)){const Q=u.get(P)??[];Q.push(L),u.set(P,Q)}else j.push(L)}for(const L of u.values())L.sort((P,Q)=>P.ts.localeCompare(Q.ts));const H=new Map;for(const L of E){let P=L;const Q=new Set([L.msg_id]);for(;;){const ue=typeof P.related_msg_id=="string"?P.related_msg_id:null;if(!ue||Q.has(ue))break;const $e=r.get(ue);if(!$e)break;Q.add(ue),P=$e}H.set(L.msg_id,P.msg_id)}return{roots:j,childrenOf:u,rootIdOf:H}},[E]),D=(0,p.useMemo)(()=>{const r=[];let u=null;for(const j of K){const H=Ga(j.ts);(!u||u.day!==H)&&(u={day:H,rows:[]},r.push(u)),u.rows.push(j)}return r},[K]),je=(A?.nextCursor??null)!==null,ke=(0,p.useCallback)(()=>h(r=>r+S),[]),ea=r=>{d(a.includes(r)?a.filter(u=>u!==r):[...a,r])},aa=r=>{d(r.some(u=>a.includes(u))?a.filter(u=>!r.includes(u)):[...a,...r.filter(u=>!a.includes(u))])},na=r=>z.filter(u=>r.some(j=>j==="broadcast"?u.broadcast:u.kind===j)).length,ta=r=>r==="broadcast"?z.filter(u=>u.broadcast).length:A?.byKind?.[r]??z.filter(u=>u.kind===r).length,ra=r=>r.replaceAll("_"," "),Ne=a.length>0||!!v||!!c||!!_.trim()||!k,De=a.length+(v?1:0)+(c?1:0)+(_.trim()?1:0)+(k?0:1),oa=()=>{d([]),g(""),o(""),b(""),y("system")},G=(0,p.useMemo)(()=>{const r=[];for(const u of D){r.push({kind:"day",id:`day:${u.day}`,day:u.day});for(const j of u.rows)r.push({kind:"item",id:`item:${j.msg_id}`,row:j,replies:n.get(j.msg_id)??[]})}return r},[D,n]),Le=(0,p.useRef)(null),ne=le({count:G.length,getScrollElement:()=>Le.current,estimateSize:()=>44,overscan:12});(0,p.useEffect)(()=>{ne.measure()},[G,ne]);const U=l?x.get(l)??l:null,sa=(0,p.useMemo)(()=>new Set(U?[`item:${U}`]:[]),[U]),te=(0,p.useRef)({id:null,tries:0}),Se=(0,p.useRef)(null);(0,p.useEffect)(()=>{if(!l){Se.current=null,te.current={id:null,tries:0};return}const r=U??l,u=G.findIndex(j=>j.kind==="item"&&j.row.msg_id===r);if(u>=0){Se.current!==l&&(Se.current=l,ne.scrollToIndex(u,{align:"center"}));return}te.current.id!==l&&(te.current={id:l,tries:0}),je&&te.current.tries<5&&(te.current.tries+=1,ke())},[l,U,G,je,ke,ne]);const ia=(0,p.useMemo)(()=>[{key:"event",header:"",headerText:"",width:1,toCopyText:r=>r.kind==="item"?r.row.summary??"":Fe(r.day),cellStyle:{display:"block",padding:0,overflow:"visible"},render:({row:r,isSelected:u})=>r.kind==="day"?(0,e.jsx)("div",{className:"pc-advfeed__daysep",children:(0,e.jsx)("span",{children:Fe(r.day)})}):(0,e.jsx)(Be,{row:r.row,children:r.replies,open:!1,active:u,onToggle:()=>{f(j=>j===r.row.msg_id?null:r.row.msg_id)},onPlanClick:j=>{o(j)},onAgentClick:j=>{g(j)}})}],[f,o,g]),Ce=U?E.find(r=>r.msg_id===U):null;return(0,e.jsx)(ae,{detailOpen:l!=null,onBack:l?()=>{f(null)}:void 0,filters:(0,e.jsxs)("div",{className:"pc-advfeed__filters",children:[(0,e.jsxs)("div",{className:"pc-advfeed__filterhead",children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("span",{children:[(0,e.jsx)(ma,{size:12,"aria-hidden":!0}),"Filter activity"]}),(0,e.jsx)("p",{children:"System coordination messages for debugging, newest first."})]}),(0,e.jsxs)("div",{className:"pc-advfeed__filtermeta",children:[(0,e.jsx)("strong",{children:A?`${A.total} matching`:N.loading?"loading…":"0 matching"}),(0,e.jsxs)("span",{children:[K.length," shown"]}),(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advfeed__refresh","aria-label":"Reload activity log",disabled:N.fetching,onClick:()=>N.invalidate(),children:(0,e.jsx)(X,{size:11,"aria-hidden":!0})})]})]}),(0,e.jsxs)("div",{className:"pc-advfeed__needsline","aria-label":"Activity summary",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)(He,{size:11,"aria-hidden":!0})," ",W.humanCount," to human"]}),(0,e.jsxs)("span",{children:[(0,e.jsx)(ga,{size:11,"aria-hidden":!0})," ",W.escalationCount," escalation"]}),(0,e.jsxs)("span",{children:[(0,e.jsx)(Ie,{size:11,"aria-hidden":!0})," ",W.broadcastCount," broadcast"]}),(0,e.jsx)("strong",{children:Ne?`${De} filter${De===1?"":"s"} active`:"No filters"})]}),(0,e.jsxs)("div",{className:"pc-coord__filters pc-advfeed__kindgroups",role:"group","aria-label":"Activity category filter",children:[Qa.map(r=>{const u=r.kinds.some(H=>a.includes(H)),j=na(r.kinds);return(0,e.jsx)(re,{label:r.description,children:(0,e.jsxs)(F,{className:"pc-advfeed__groupchip",active:u,accent:"var(--advconv-accent)",onClick:()=>aa(r.kinds),"aria-pressed":u,children:[r.label,j>0?(0,e.jsx)("span",{className:"pc-advfeed__kindn",children:j}):null]})},r.id)}),(0,e.jsx)(re,{label:"System-origin envelopes only (watchdog, git-sync, routines). Turn off to include agent-to-agent traffic — what a Fleet-sidebar message click does.",children:(0,e.jsx)(F,{className:"pc-advfeed__systoggle",active:k,accent:"var(--advconv-accent)",onClick:()=>{y(k?"all":"system")},"aria-pressed":k,"data-testid":"feed-system-only-chip",children:"System only"})}),(0,e.jsx)(F,{className:"pc-advfeed__advancedtoggle",active:s==="open",accent:"#a78bfa",onClick:()=>{w(s==="open"?"closed":"open")},"aria-expanded":s==="open",children:"Advanced / all kinds"})]}),s==="open"&&(0,e.jsx)("div",{className:"pc-coord__filters pc-advfeed__rawkinds",role:"group","aria-label":"Raw kind filter",children:Ha.map(r=>{const u=ta(r),j=a.includes(r);return(0,e.jsxs)(F,{className:"pc-advfeed__kindchip",active:j,accent:se[r]??oe,onClick:()=>ea(r),"aria-pressed":j,children:[(0,e.jsx)("span",{className:"pc-advfeed__kinddot",style:{background:se[r]??oe},"aria-hidden":!0}),ra(r),typeof u=="number"&&u>0?(0,e.jsx)("span",{className:"pc-advfeed__kindn",children:u}):null]},r)})}),(0,e.jsxs)("div",{className:"pc-advfeed__inputs",children:[(0,e.jsxs)("label",{className:"pc-advfeed__field",children:[(0,e.jsx)("span",{children:"Agent"}),(0,e.jsx)("input",{className:"pc-advfeed__input",style:ze,placeholder:"from or to…",value:v,onChange:r=>{g(r.target.value)},"aria-label":"Filter by agent"})]}),(0,e.jsxs)("label",{className:"pc-advfeed__field",children:[(0,e.jsx)("span",{children:"Plan"}),(0,e.jsx)("input",{className:"pc-advfeed__input",style:ze,placeholder:"plan slug…",value:c,onChange:r=>{o(r.target.value)},"aria-label":"Filter by plan slug"})]}),(0,e.jsxs)("label",{className:"pc-advfeed__field pc-advfeed__field--search",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)(Ue,{size:10,"aria-hidden":!0}),"Search"]}),(0,e.jsx)("input",{type:"search",className:"pc-advfeed__input pc-advfeed__input--search",style:ze,placeholder:"summary, body, event…",value:m,onChange:r=>{b(r.target.value)},"aria-label":"Free-text search"})]}),Ne&&(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advfeed__clear",onClick:oa,children:"clear"})]}),Ne&&(0,e.jsxs)("div",{className:"pc-advfeed__scopebar","aria-label":"Active feed filters",children:[(0,e.jsx)("span",{children:"Showing"}),a.length>0&&(0,e.jsx)("strong",{children:a.join(", ")}),!k&&(0,e.jsx)("strong",{children:"incl. agent traffic"}),v&&(0,e.jsxs)("strong",{children:["agent: ",v]}),c&&(0,e.jsxs)("strong",{children:["plan: ",c]}),_.trim()&&(0,e.jsxs)("strong",{children:["search: ",_.trim()]})]})]}),list:(0,e.jsxs)("div",{className:"pc-advfeed__stream",ref:Le,children:[N.loading&&E.length===0?(0,e.jsx)(ee,{rows:6,label:"Loading the coordination feed"}):N.error?(0,e.jsx)(Ye,{children:Ze(void 0,N.error.message)}):K.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(Te,{size:22,"aria-hidden":!0}),title:"No matching traffic",desc:"Clear a filter or broaden the search to return activity."}):(0,e.jsx)(ge,{inline:!0,disableCopySupport:!0,headerStyle:{display:"none"},columns:ia,getRowId:r=>r.id,virtualMode:{virtualizer:ne,totalRows:G.length,rowAt:r=>G[r],measureAll:!0},selectedRowIds:sa,getRowBg:we,rowProps:Fa}),je&&K.length>0&&(0,e.jsx)("button",{type:"button",className:"pc-advfeed__loadolder",onClick:ke,disabled:N.fetching,children:N.fetching?"Loading…":"Load older ↓"})]}),detail:Ce?(0,e.jsx)("section",{className:"pc-coord__detail pc-advfeed__detailpane",children:(0,e.jsx)(Be,{row:Ce,children:n.get(Ce.msg_id)??[],open:!0,active:!0,detail:!0,onToggle:()=>{},onPlanClick:r=>{o(r)},onAgentClick:r=>{g(r)}})}):(0,e.jsx)("section",{className:"pc-coord__detail",children:(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(Te,{size:22,"aria-hidden":!0}),title:"Select a message",desc:"Open a system-log message to view its full body and replies."})})})}function Be({row:a,children:d,open:s,active:w=!1,detail:v=!1,onToggle:g,onPlanClick:c,onAgentClick:o}){const m=a.kind,b=se[a.broadcast?"broadcast":m]??oe,_=a.summary||(a.kind==="plan_event"&&a.event?`${a.event}${a.detail?`: ${a.detail}`:""}`:""),l=!!a.body||d.length>0||!!a.detail||!!a.next_action;return(0,e.jsxs)("div",{className:`pc-advfeed__item${s?" is-open":""}${w?" is-active":""}${v?" pc-advfeed__item--detail":""}`,children:[(0,e.jsxs)("div",{className:"pc-advfeed__row",children:[(0,e.jsx)("span",{className:"pc-advfeed__time",title:a.ts,children:Ja(a.ts)}),(0,e.jsxs)("span",{className:"pc-advfeed__badge",style:{borderColor:b,color:b,"--feed-kind-color":b},children:[(0,e.jsx)("span",{"aria-hidden":!0}),m]}),(0,e.jsxs)("span",{className:"pc-advfeed__route",children:[(0,e.jsx)("button",{type:"button",className:"pc-advfeed__from",onClick:()=>o(a.from),"aria-label":`Filter to ${a.from}`,children:a.from}),(0,e.jsx)(Ya,{to:a.to??[],broadcast:a.broadcast})]}),(0,e.jsx)("button",{type:"button",className:"pc-advfeed__summary",onClick:g,"aria-expanded":s,"aria-label":l?"Expand row":void 0,children:_||(0,e.jsx)("em",{className:"pc-advfeed__nosum",children:"(no summary)"})}),a.plan_slug&&(0,e.jsx)("button",{type:"button",className:"pc-advfeed__planchip",onClick:()=>c(a.plan_slug),"aria-label":`Filter to ${a.plan_slug}`,children:a.plan_slug}),d.length>0&&(0,e.jsxs)("span",{className:"pc-advfeed__replyn",children:[d.length," ",d.length===1?"reply":"replies"]}),(0,e.jsx)("span",{className:"pc-advfeed__rel",children:Pe(a.ts)})]}),s&&l&&(0,e.jsxs)("div",{className:"pc-advfeed__detail",children:[(0,e.jsxs)("div",{className:"pc-advfeed__detailhead",children:[(0,e.jsx)("span",{children:a.surface}),(0,e.jsx)("span",{children:Ae(a.ts)}),a.event&&(0,e.jsx)("span",{children:a.event})]}),a.body&&(0,e.jsxs)("div",{className:"pc-advfeed__bodycard",children:[(0,e.jsx)("strong",{children:"Body"}),(0,e.jsx)("p",{className:"pc-advfeed__body",children:a.body})]}),a.next_action&&(0,e.jsxs)("div",{className:"pc-advfeed__kv pc-advfeed__kv--action",children:[(0,e.jsx)("strong",{children:"next action"}),(0,e.jsx)("span",{children:a.next_action})]}),a.detail&&!_.includes(a.detail)&&(0,e.jsxs)("div",{className:"pc-advfeed__kv",children:[(0,e.jsx)("strong",{children:"detail"}),(0,e.jsx)("span",{children:a.detail})]}),d.length>0&&(0,e.jsx)("ol",{className:"pc-advfeed__thread",children:d.map(f=>(0,e.jsxs)("li",{children:[(0,e.jsx)("span",{className:"pc-advfeed__threadrail","aria-hidden":!0}),(0,e.jsxs)("span",{className:"pc-advfeed__threadmeta",children:[(0,e.jsxs)("span",{className:"pc-advfeed__badge pc-advfeed__badge--sm",style:{borderColor:se[f.kind]??oe,color:se[f.kind]??oe},children:[(0,e.jsx)("span",{"aria-hidden":!0}),f.kind]}),(0,e.jsx)("strong",{children:f.from}),(0,e.jsx)("em",{children:Pe(f.ts)})]}),(0,e.jsx)("span",{className:"pc-advfeed__threadsum",children:f.summary??(f.choice?`choice: ${f.choice}`:f.body??"")})]},f.msg_id))})]})]})}var Ke=["open","resolved","closed","all"],Ve=["all","question","discussion"];function Xa({kind:a,busy:d,onReply:s,onResolve:w}){const[v,g]=(0,p.useState)(""),c=v.trim();return(0,e.jsxs)("div",{className:"pc-advconv__reply",children:[(0,e.jsxs)("div",{className:"pc-advconv__replyhead",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)(J,{size:13,"aria-hidden":!0}),"Thread response"]}),(0,e.jsx)("em",{children:a==="question"?"Resolve with an accepted answer when this closes the loop.":"Add context for everyone subscribed to this discussion."})]}),(0,e.jsx)("textarea",{value:v,onChange:o=>g(o.target.value),placeholder:a==="question"?"Write a reply, or accept it as the answer…":"Write a reply…",rows:2}),(0,e.jsxs)("div",{className:"pc-coord__actions pc-advconv__replyactions",children:[(0,e.jsxs)("button",{type:"button",className:"pc-advconv__replybtn",disabled:d||!c,onClick:()=>{s(c).then(o=>{o&&g("")})},children:[(0,e.jsx)(xe,{size:12,"aria-hidden":!0})," Reply"]}),a==="question"&&(0,e.jsxs)("button",{type:"button",className:"pc-advconv__replybtn pc-advconv__replybtn--resolve",disabled:d||!c,"aria-label":"Record this reply as the accepted answer and resolve the question",onClick:()=>{w(c).then(o=>{o&&g("")})},children:[(0,e.jsx)(We,{size:12,"aria-hidden":!0})," Accept as answer"]})]})]})}function en({detailOnly:a=!1,loadingSummary:d}={}){const[s,w]=I("cstate",ie([...Ke]).withDefault("open")),[v,g]=I("ckind",ie([...Ve]).withDefault("all")),[c,o]=I("ctopic",R.withDefault("")),[m,b]=I("conversation",R),[_,l]=(0,p.useState)(!1),f=Oe("cref",null),i=(0,p.useCallback)(n=>{if(n.kind==="conversation"){b(n.ref);return}f.open(n)},[f,b]),y=q({queryName:"conversations.questionsList",args:{limit:B},enabled:!a,staleTime:3e4}),k=q({queryName:"conversations.questionDetail",args:{id:m??""},enabled:!!m,staleTime:3e4}),S=y.data??[],T=k.data?.[0]??null,h=T&&T.id===m?T:null,C=y.loading,O=y.error?ce(y.error):null,$=(0,p.useMemo)(()=>{const n=new Set;for(const x of S)for(const D of x.topics??[])n.add(D);return[...n].sort()},[S]),t=(0,p.useMemo)(()=>S.filter(n=>(s==="all"||n.state===s)&&(v==="all"||n.kind===v)&&(!c||(n.topics??[]).includes(c))),[S,s,v,c]),N=async(n,x)=>{l(!0);try{return await Da(n,x),y.invalidate(),m&&k.invalidate(),!0}catch(D){return Oa.toast.error(`Action failed: ${ce(D)}`),!1}finally{l(!1)}},z=!!h&&h.state!=="closed"&&!h.promoted_issue_id,A=(0,p.useRef)(null),E=le({count:m?0:t.length,getScrollElement:()=>A.current,estimateSize:()=>76,overscan:10});(0,p.useEffect)(()=>{m||E.measure()},[t,E,m]);const W=(0,p.useMemo)(()=>new Set(m?[m]:[]),[m]),K=(0,p.useMemo)(()=>[{key:"thread",header:"",headerText:"",width:1,toCopyText:n=>n.title??n.id,cellStyle:{display:"block",padding:0,overflow:"visible"},render:({row:n,isSelected:x})=>(0,e.jsxs)("div",{className:`pc-coord__row${x?" is-active":""}`,children:[(0,e.jsxs)("span",{className:"pc-advconv__threadtop",children:[(0,e.jsx)("span",{className:`pc-coord__kind pc-coord__kind--${n.kind}`,children:n.kind}),(0,e.jsx)("span",{className:`pc-advconv__statepill pc-advconv__statepill--${n.state}`,children:n.state}),(0,e.jsx)("span",{className:"pc-advconv__rowdate",children:Ae(n.created_ts)})]}),(0,e.jsx)("span",{className:"pc-coord__row-title",children:n.title??n.id}),(0,e.jsxs)("span",{className:"pc-coord__row-meta",children:[n.harness_slug?V(n.harness_slug):"workspace",n.promoted_issue_id?` · → ${n.promoted_issue_id}`:""]}),(n.topics??[]).length>0&&(0,e.jsx)("span",{className:"pc-advconv__rowtags",children:(n.topics??[]).map(D=>(0,e.jsxs)("span",{className:"pc-coord__tag",children:["#",D]},D))})]})}],[]);return(0,e.jsx)(ae,{detailOnly:a,detailOpen:!!m,onBack:()=>{b(null)},filters:m?void 0:(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-advconv__railhead",children:[(0,e.jsx)("span",{style:be,children:"Question & discussion threads"}),(0,e.jsx)("strong",{children:C&&t.length===0?"…":t.length})]}),(0,e.jsx)("div",{className:"pc-coord__filters",role:"group","aria-label":"State filter",children:Ke.map(n=>(0,e.jsx)(F,{active:s===n,accent:"var(--advconv-accent)","aria-pressed":s===n,onClick:()=>{w(n)},children:n},n))}),(0,e.jsxs)("div",{className:"pc-coord__filters",role:"group","aria-label":"Kind filter",children:[Ve.map(n=>(0,e.jsx)(F,{active:v===n,accent:"var(--advconv-accent)","aria-pressed":v===n,onClick:()=>{g(n)},children:n},n)),(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advconv__refresh","aria-label":"Reload conversations",disabled:C,onClick:()=>y.invalidate(),children:(0,e.jsx)(X,{size:11,"aria-hidden":!0})})]}),$.length>0&&(0,e.jsxs)("div",{className:"pc-coord__filters",role:"group","aria-label":"Topic filter",children:[(0,e.jsx)(F,{active:!c,accent:"var(--advconv-accent)","aria-pressed":!c,onClick:()=>{o("")},children:"all topics"}),$.map(n=>(0,e.jsxs)(F,{active:c===n,accent:"var(--advconv-accent)","aria-pressed":c===n,onClick:()=>{o(c===n?"":n)},children:["#",n]},n))]})]}),list:m?void 0:(0,e.jsx)("div",{className:"pc-advconv__listscroll",ref:A,children:C&&t.length===0?(0,e.jsx)(ee,{}):O&&t.length===0?(0,e.jsx)(de,{message:O,onRetry:()=>y.invalidate()}):t.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(J,{size:22,"aria-hidden":!0}),title:"No threads match",desc:"Change the state, kind, or topic filter to widen the thread rail."}):(0,e.jsx)(ge,{inline:!0,disableCopySupport:!0,headerStyle:{display:"none"},columns:K,getRowId:n=>n.id,virtualMode:{virtualizer:E,totalRows:t.length,rowAt:n=>t[n],measureAll:!0},selectedRowIds:W,onRowClick:n=>{b(n.id)},getRowBg:we,rowProps:Ee})}),detail:(0,e.jsx)("section",{className:"pc-coord__detail",children:m&&!h?(0,e.jsx)(ye,{row:d,label:"Loading conversation"}):h?(0,e.jsxs)("article",{className:"pc-coord__card",children:[(0,e.jsxs)("header",{className:"pc-advconv__detailhead",children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("p",{className:"pc-advconv__detailkicker",children:[(0,e.jsx)("span",{className:`pc-coord__kind pc-coord__kind--${h.kind}`,children:h.kind}),(0,e.jsx)("span",{className:`pc-advconv__statepill pc-advconv__statepill--${h.state}`,children:h.state})]}),(0,e.jsx)("h2",{children:h.title??h.id})]}),(0,e.jsxs)("div",{className:"pc-advconv__detailstats","aria-label":"Conversation metadata",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)("strong",{children:h.subscriber_count})," follower",h.subscriber_count===1?"":"s"]}),(0,e.jsx)("span",{children:h.scope==="harness"&&h.harness_slug?V(h.harness_slug):"workspace"}),h.asker_id&&(0,e.jsxs)("span",{children:["asked by ",h.asker_id]})]})]}),h.topics.length>0&&(0,e.jsx)("p",{className:"pc-coord__tags",children:h.topics.map(n=>(0,e.jsxs)("span",{className:"pc-coord__tag",children:["#",n]},n))}),h.body&&(0,e.jsx)("p",{className:"pc-coord__body",children:(0,e.jsx)(Y,{text:h.body,harnessSlug:h.harness_slug,onOpen:i})}),h.accepted_answer&&(0,e.jsxs)("div",{className:"pc-advconv__callout pc-advconv__callout--accepted",children:[(0,e.jsx)(We,{size:15,"aria-hidden":!0}),(0,e.jsxs)("div",{children:[(0,e.jsx)("strong",{children:"Accepted answer"}),(0,e.jsx)("p",{children:(0,e.jsx)(Y,{text:h.accepted_answer,harnessSlug:h.harness_slug,onOpen:i})})]})]}),h.promoted_issue_id&&(0,e.jsxs)("div",{className:"pc-advconv__callout pc-advconv__callout--linked",children:[(0,e.jsx)(qe,{size:15,"aria-hidden":!0}),(0,e.jsxs)("div",{children:[(0,e.jsx)("strong",{children:"Linked work-item"}),(0,e.jsxs)("p",{children:[(0,e.jsx)(me,{refValue:{kind:"issue",ref:h.promoted_issue_id},harnessSlug:h.harness_slug,onOpen:i,size:"sm"}),(0,e.jsx)("em",{children:"Promoted to an engineer issue; implementation discussion continues there."})]})]})]}),(0,e.jsx)("div",{className:"pc-coord__actions",children:z&&(0,e.jsxs)("button",{type:"button",disabled:_,"aria-label":"Promote this conversation to an engineer issue",onClick:()=>{N("conversations/promote",{conversation_id:h.id})},children:[(0,e.jsx)(qe,{size:13,"aria-hidden":!0})," Promote to issue"]})}),h.posts.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(J,{size:22,"aria-hidden":!0}),title:"No replies yet",desc:"This thread is waiting for its first response."}):(0,e.jsx)("ol",{className:"pc-coord__thread",children:h.posts.map(n=>(0,e.jsxs)("li",{children:[(0,e.jsxs)("span",{className:"pc-advconv__postmeta",children:[(0,e.jsx)("strong",{children:n.author_id??"unknown"}),n.created_ts&&(0,e.jsx)("span",{children:Ae(n.created_ts)})]}),(0,e.jsx)("p",{children:(0,e.jsx)(Y,{text:n.body,harnessSlug:h.harness_slug,onOpen:i})})]},n.id))}),f.element,h.state==="open"&&(0,e.jsx)(Xa,{kind:h.kind,busy:_,onReply:n=>N("conversations/post",{conversation_id:h.id,body:n}),onResolve:n=>N("conversations/resolve",{conversation_id:h.id,accepted_answer:n})},h.id)]}):(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(J,{size:22,"aria-hidden":!0}),title:"Select a thread",desc:"Open a question or discussion to review context, replies, accepted answers, and linked work-items."})})})}function an({detailOnly:a=!1,loadingSummary:d}={}){const[s,w]=I("thread",R),[,v]=pe(ve),g=q({queryName:"conversations.deliberationList",args:{limit:B},enabled:!a,staleTime:3e4}),c=q({queryName:"conversations.deliberationDetail",args:{id:s??""},enabled:!!s,staleTime:3e4}),o=g.data??[],m=Qe(o),b=c.data?.[0],_=b&&b.thread?.thread_id===s?b:void 0,l=_?.thread??null,f=_?.posts??[],i=g.loading,y=g.error?ce(g.error):null,k=(0,p.useMemo)(()=>{const t=za(l?.parent_kind);return t&&l?.parent_ref?{kind:t,ref:l.parent_ref}:null},[l?.parent_kind,l?.parent_ref]),S=Oe("cref",l?.harness_slug??null),T=(0,p.useCallback)(t=>{if(t.kind==="conversation"){v({conv:"threads",...he,conversation:t.ref});return}S.open(t)},[S,v]),h=(0,p.useRef)(null),C=le({count:s?0:o.length,getScrollElement:()=>h.current,estimateSize:()=>70,overscan:10});(0,p.useEffect)(()=>{s||C.measure()},[o,C,s]);const O=(0,p.useMemo)(()=>new Set(s?[s]:[]),[s]),$=(0,p.useMemo)(()=>[{key:"thread",header:"",headerText:"",width:1,toCopyText:t=>t.title??t.thread_id,cellStyle:{display:"block",padding:0,overflow:"visible"},render:({row:t,isSelected:N})=>(0,e.jsxs)("div",{className:`pc-coord__row${N?" is-active":""}`,children:[(0,e.jsxs)("span",{className:"pc-advconv__threadtop",children:[(0,e.jsx)("span",{className:"pc-coord__kind",children:t.parent_kind??"thread"}),t.parent_ref?(0,e.jsx)("span",{className:"pc-advconv__statepill",children:t.parent_ref}):null,(0,e.jsx)("span",{className:"pc-advconv__rowdate",children:Z(t.last_post_at??t.created_at)})]}),(0,e.jsx)("span",{className:"pc-coord__row-title",children:t.title??t.thread_id}),(0,e.jsxs)("span",{className:"pc-coord__row-meta",children:[t.harness_slug?V(t.harness_slug):"workspace"," · ",t.post_count," post",t.post_count===1?"":"s",t.created_by?` · ${t.created_by}`:""]})]})}],[]);return(0,e.jsx)(ae,{detailOnly:a,detailOpen:!!s,onBack:()=>{w(null)},filters:s?void 0:(0,e.jsxs)("div",{className:"pc-advconv__railhead",children:[(0,e.jsx)("span",{style:be,children:"Deliberation threads"}),(0,e.jsx)("strong",{children:i&&o.length===0?"…":Ge(o.length,m)}),(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advconv__refresh","aria-label":"Reload deliberations",disabled:i,onClick:()=>g.invalidate(),children:(0,e.jsx)(X,{size:11,"aria-hidden":!0})})]}),list:s?void 0:(0,e.jsx)("div",{className:"pc-advconv__listscroll",ref:h,children:i&&o.length===0?(0,e.jsx)(ee,{}):y&&o.length===0?(0,e.jsx)(de,{message:y,onRetry:()=>g.invalidate()}):o.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(_e,{size:22,"aria-hidden":!0}),title:"No deliberations",desc:"No coord:thread / deliberate / vote discussions recorded."}):(0,e.jsx)(ge,{inline:!0,disableCopySupport:!0,headerStyle:{display:"none"},columns:$,getRowId:t=>t.thread_id,virtualMode:{virtualizer:C,totalRows:o.length,rowAt:t=>o[t],measureAll:!0},selectedRowIds:O,onRowClick:t=>{w(t.thread_id)},getRowBg:we,rowProps:Ee})}),detail:(0,e.jsx)("section",{className:"pc-coord__detail",children:s&&!l?(0,e.jsx)(ye,{row:d,label:"Loading deliberation"}):l?(0,e.jsxs)("article",{className:"pc-coord__card",children:[(0,e.jsxs)("header",{className:"pc-advconv__detailhead",children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("p",{className:"pc-advconv__detailkicker",children:[(0,e.jsx)("span",{className:"pc-coord__kind",children:l.parent_kind??"thread"}),k?(0,e.jsx)(me,{refValue:k,harnessSlug:l.harness_slug,onOpen:T,size:"sm"}):l.parent_ref?(0,e.jsx)("span",{className:"pc-advconv__statepill",children:l.parent_ref}):null]}),(0,e.jsx)("h2",{children:l.title??l.thread_id})]}),(0,e.jsxs)("div",{className:"pc-advconv__detailstats","aria-label":"Thread metadata",children:[(0,e.jsx)("span",{children:l.harness_slug?V(l.harness_slug):"workspace"}),(0,e.jsxs)("span",{children:[(0,e.jsx)("strong",{children:f.length})," posts"]})]})]}),f.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(_e,{size:22,"aria-hidden":!0}),title:"No posts",desc:"This thread has no recorded posts."}):(0,e.jsx)("ol",{className:"pc-coord__thread pc-advconv__transcript",children:f.map(t=>(0,e.jsxs)("li",{className:"pc-advconv__turn",children:[(0,e.jsxs)("span",{className:"pc-advconv__postmeta",children:[(0,e.jsx)("strong",{children:t.author_id??"unknown"}),(0,e.jsx)("span",{children:Z(t.created_at)})]}),(0,e.jsx)("p",{children:(0,e.jsx)(Y,{text:t.body,harnessSlug:t.harness_slug??l.harness_slug,onOpen:T})})]},t.id))}),S.element]}):(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(_e,{size:22,"aria-hidden":!0}),title:"Select a deliberation",desc:"Open a thread to read its discussion posts."})})})}function nn({detailOnly:a=!1,loadingSummary:d}={}){const[s,w]=I("acharness",R.withDefault("")),[v,g]=I("acrole",R.withDefault("")),[c,o]=I("chat",R),m=q({queryName:"conversations.agentChatList",args:(0,p.useMemo)(()=>({limit:B,...s?{harness:s}:{},...v?{role:v}:{}}),[s,v]),enabled:!a,staleTime:3e4}),b=q({queryName:"conversations.agentChatDetail",args:{id:c??""},enabled:!!c,staleTime:3e4}),_=m.data??[],l=Qe(_),f=b.data?.[0]??null,i=f&&f.id===c?f:null,y=m.loading,k=m.error?ce(m.error):null,S=(0,p.useMemo)(()=>[...new Set(_.map(t=>t.harness_slug).filter(Boolean))].sort(),[_]),T=(0,p.useMemo)(()=>[...new Set(_.map(t=>t.role).filter(Boolean))].sort(),[_]),h=(0,p.useRef)(null),C=le({count:c?0:_.length,getScrollElement:()=>h.current,estimateSize:()=>64,overscan:10});(0,p.useEffect)(()=>{c||C.measure()},[_,C,c]);const O=(0,p.useMemo)(()=>new Set(c?[c]:[]),[c]),$=(0,p.useMemo)(()=>[{key:"session",header:"",headerText:"",width:1,toCopyText:t=>t.title??t.id,cellStyle:{display:"block",padding:0,overflow:"visible"},render:({row:t,isSelected:N})=>(0,e.jsxs)("div",{className:`pc-coord__row${N?" is-active":""}`,children:[(0,e.jsxs)("span",{className:"pc-advconv__threadtop",children:[(0,e.jsx)("span",{className:"pc-coord__kind",children:t.role??"agent"}),t.archived_at?(0,e.jsx)("span",{className:"pc-advconv__statepill pc-advconv__statepill--closed",children:"archived"}):null,(0,e.jsx)("span",{className:"pc-advconv__rowdate",children:Z(t.created_at)})]}),(0,e.jsx)("span",{className:"pc-coord__row-title",children:t.title??t.id}),(0,e.jsxs)("span",{className:"pc-coord__row-meta",children:[t.harness_slug?V(t.harness_slug):"workspace",t.feature_id?` · ${t.feature_id}`:""," · ",t.turns," turn",t.turns===1?"":"s"]})]})}],[]);return(0,e.jsx)(ae,{detailOnly:a,detailOpen:!!c,onBack:()=>{o(null)},filters:c?void 0:(0,e.jsxs)(e.Fragment,{children:[(0,e.jsxs)("div",{className:"pc-advconv__railhead",children:[(0,e.jsx)("span",{style:be,children:"Agent chat sessions"}),(0,e.jsx)("strong",{children:y&&_.length===0?"…":Ge(_.length,l)})]}),S.length>0&&(0,e.jsxs)("div",{className:"pc-coord__filters",role:"group","aria-label":"Harness filter",children:[(0,e.jsx)(F,{active:!s,accent:"var(--advconv-accent)","aria-pressed":!s,onClick:()=>{w("")},children:"all"}),S.map(t=>(0,e.jsx)(F,{active:s===t,accent:"var(--advconv-accent)","aria-pressed":s===t,onClick:()=>{w(s===t?"":t)},children:t},t)),(0,e.jsx)("button",{type:"button",className:"pc-coord__chip pc-advconv__refresh","aria-label":"Reload agent chats",disabled:y,onClick:()=>m.invalidate(),children:(0,e.jsx)(X,{size:11,"aria-hidden":!0})})]}),T.length>0&&(0,e.jsxs)("div",{className:"pc-coord__filters",role:"group","aria-label":"Role filter",children:[(0,e.jsx)(F,{active:!v,accent:"var(--advconv-accent)","aria-pressed":!v,onClick:()=>{g("")},children:"all roles"}),T.map(t=>(0,e.jsx)(F,{active:v===t,accent:"var(--advconv-accent)","aria-pressed":v===t,onClick:()=>{g(v===t?"":t)},children:t},t))]})]}),list:c?void 0:(0,e.jsx)("div",{className:"pc-advconv__listscroll",ref:h,children:y&&_.length===0?(0,e.jsx)(ee,{}):k&&_.length===0?(0,e.jsx)(de,{message:k,onRetry:()=>m.invalidate()}):_.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(fe,{size:22,"aria-hidden":!0}),title:"No agent chats",desc:"No multi-turn agent chat sessions match the current filter."}):(0,e.jsx)(ge,{inline:!0,disableCopySupport:!0,headerStyle:{display:"none"},columns:$,getRowId:t=>t.id,virtualMode:{virtualizer:C,totalRows:_.length,rowAt:t=>_[t]},selectedRowIds:O,onRowClick:t=>{o(t.id)},getRowBg:we,rowProps:Ee})}),detail:(0,e.jsx)("section",{className:"pc-coord__detail",children:c&&!i?(0,e.jsx)(ye,{row:d,label:"Loading chat"}):i?(0,e.jsxs)("article",{className:"pc-coord__card",children:[(0,e.jsxs)("header",{className:"pc-advconv__detailhead",children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("p",{className:"pc-advconv__detailkicker",children:[(0,e.jsx)("span",{className:"pc-coord__kind",children:i.role??"agent"}),i.feature_id?(0,e.jsx)("span",{className:"pc-advconv__statepill",children:i.feature_id}):null]}),(0,e.jsx)("h2",{children:i.title??i.id})]}),(0,e.jsxs)("div",{className:"pc-advconv__detailstats","aria-label":"Chat metadata",children:[(0,e.jsx)("span",{children:i.harness_slug?V(i.harness_slug):"workspace"}),(0,e.jsxs)("span",{children:[(0,e.jsx)("strong",{children:(i.transcript??[]).length})," turns"]}),(0,e.jsxs)("span",{children:["$",((i.total_cost_usd_cents??0)/100).toFixed(2)," · ",(i.total_input_tokens??0)+(i.total_output_tokens??0)," tok"]})]})]}),i.archived_at==null&&i.harness_slug?(0,e.jsx)("div",{className:"pc-advconv__livechat","data-testid":"advconv-live-chat",children:(0,e.jsx)(wa,{slug:i.harness_slug,chatId:i.id,onArchive:()=>{o(null),m.invalidate(),b.invalidate()}})}):(i.transcript??[]).length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(fe,{size:22,"aria-hidden":!0}),title:"Empty transcript",desc:"This chat session has no recorded turns."}):(0,e.jsx)("ol",{className:"pc-coord__thread pc-advconv__transcript",children:(i.transcript??[]).map((t,N)=>{const z=ba(t);return(0,e.jsxs)("li",{className:`pc-advconv__turn pc-advconv__turn--${t.role??"unknown"}`,children:[(0,e.jsxs)("span",{className:"pc-advconv__postmeta",children:[(0,e.jsx)("strong",{children:t.role??"unknown"}),t.ts?(0,e.jsx)("span",{children:Z(t.ts)}):null]}),(0,e.jsx)("p",{children:Ca(z.content)})]},N)})})]}):(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(fe,{size:22,"aria-hidden":!0}),title:"Select a chat",desc:"Open an agent chat session to read its full transcript."})})})}function tn({detailOnly:a=!1,loadingSummary:d}){const[s,w]=pe(ve),v=s.cmsg,g=q({queryName:"conversations.agentMessageDetail",args:{id:v??""},enabled:!!v,staleTime:3e4}).data?.[0]??null,c=g&&g.message?.msg_id===v?g:null,o=c?.message,m=c?.replies??[],b=Oe("cref",o?.harness_slug??null),_=(0,p.useCallback)(f=>{if(f.kind==="conversation"){w({conv:"threads",...he,conversation:f.ref});return}b.open(f)},[b,w]),l=(0,p.useMemo)(()=>ka(o?.audience),[o?.audience]);return(0,e.jsx)(ae,{detailOnly:a,detail:(0,e.jsx)("section",{className:"pc-coord__detail",children:v&&!o?(0,e.jsx)(ye,{row:d,label:"Loading message"}):o?(0,e.jsxs)("article",{className:"pc-coord__card",children:[(0,e.jsxs)("header",{className:"pc-advconv__detailhead",children:[(0,e.jsxs)("div",{children:[(0,e.jsxs)("p",{className:"pc-advconv__detailkicker",children:[(0,e.jsx)("span",{className:"pc-coord__kind",children:o.kind}),o.lifecycle?(0,e.jsx)("span",{className:"pc-advconv__statepill",children:o.lifecycle}):null,o.broadcast?(0,e.jsxs)("span",{className:"pc-advconv__statepill",children:[(0,e.jsx)(Ie,{size:10,"aria-hidden":!0})," broadcast"]}):null]}),(0,e.jsx)("h2",{children:o.summary??d?.title??o.msg_id})]}),(0,e.jsxs)("div",{className:"pc-advconv__detailstats","aria-label":"Message metadata",children:[(0,e.jsx)("span",{children:o.harness_slug?V(o.harness_slug):"workspace"}),(0,e.jsxs)("span",{children:[(0,e.jsx)("strong",{children:m.length})," replies"]}),(0,e.jsx)("span",{children:Z(o.ts)})]})]}),(0,e.jsxs)("div",{className:"pc-advconv__detailstats","aria-label":"Routing",children:[(0,e.jsxs)("span",{children:["from ",o.from]}),(0,e.jsx)("span",{children:o.broadcast?"to everyone":o.to.length===0?"no direct recipient":`to ${o.to.join(", ")}`}),l?(0,e.jsxs)("span",{children:["about"," ",(0,e.jsx)(me,{refValue:l,harnessSlug:o.harness_slug,onOpen:_,size:"sm"})]}):o.plan_slug?(0,e.jsxs)("span",{children:["plan"," ",(0,e.jsx)(me,{refValue:{kind:"plan",ref:o.plan_slug},harnessSlug:o.harness_slug,onOpen:_,size:"sm"})]}):null]}),o.body?(0,e.jsx)("p",{className:"pc-advconv__body",children:(0,e.jsx)(Y,{text:o.body,harnessSlug:o.harness_slug,onOpen:_})}):null,(0,e.jsx)(Aa,{authored:o.authored}),m.length===0?(0,e.jsx)(M,{icon:(0,e.jsx)(xe,{size:22,"aria-hidden":!0}),title:"No replies",desc:"Nobody has acked or answered this message."}):(0,e.jsx)("ol",{className:"pc-coord__thread pc-advconv__transcript",children:m.map(f=>(0,e.jsxs)("li",{className:"pc-advconv__turn",children:[(0,e.jsxs)("span",{className:"pc-advconv__postmeta",children:[(0,e.jsx)("strong",{children:f.from||"unknown"}),(0,e.jsx)("span",{children:Z(f.ts)})]}),(0,e.jsx)("p",{children:(0,e.jsx)(Y,{text:f.body??f.summary,harnessSlug:o.harness_slug,onOpen:_})})]},f.msg_id))}),b.element]}):(0,e.jsx)(M,{style:{minHeight:"100%"},icon:(0,e.jsx)(xe,{size:22,"aria-hidden":!0}),title:"Select a message",desc:"Open an agent message to read its body and reply chain."})})})}function rn(){return(0,e.jsx)("style",{children:`
      .pc-advconv {
        --advconv-bg: var(--bg, #07101d);
        --advconv-panel: color-mix(in srgb, var(--bg-1, #0b1220), transparent 14%);
        --advconv-panel-strong: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%);
        --advconv-border: var(--border, rgba(125, 211, 252, 0.15));
        --advconv-border-strong: var(--border-strong, rgba(125, 211, 252, 0.32));
        --advconv-accent: var(--accent);
        --advconv-accent-strong: var(--accent-strong, var(--accent));
        --advconv-accent-soft: color-mix(in oklab, var(--accent), transparent 86%);
        --advconv-accent-softer: color-mix(in oklab, var(--accent), transparent 92%);
        --advconv-good-soft: color-mix(in oklab, var(--good, #22c55e), transparent 88%);
        --advconv-warn-soft: color-mix(in oklab, var(--warn, #f59e0b), transparent 90%);
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 0;
        color: var(--fg, #dceaf6);
        background: var(--advconv-bg);
        overflow-x: auto;
        overflow-y: hidden;
      }
      /* Shell — a persistent left nav rail + a main pane, mirroring the Create
         dock's sidebar│main split. The page title now lives in the AdvShell
         header, so there is no in-body <h1>. */
      .pc-advconv__shell {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        grid-template-columns: 64px minmax(300px, 360px) minmax(0, 1fr);
        align-items: stretch;
        background: var(--advconv-bg);
        min-width: 760px;
      }
      /* The nav reuses .pc-plans__rail (border-right + column flex + bg) for
         pixel parity with the Create sidebar; only its width is set here.

         STICKY, deliberately (P-003 / plan decisions D-001 + D-002). The shell
         below is min-width 760px inside an overflow-x:auto root, and the /adv
         content column is routinely narrower than that -- measured 2026-08-30 on
         an isolated verifier rig, the scroll container is 648px at the desktop's
         own minimum window width (tauri.conf.json minWidth 800) and 470px at a
         1200px window, so the shell scrolls horizontally by 112px and 290px
         respectively. Left unpinned the rail scrolls away with everything else:
         at 800px its left edge measured -8px at maximum scroll, i.e. navigation
         is partly off-screen exactly when the user has scrolled to read the
         detail pane. Pinning it to the scrollport keeps navigation reachable at
         every scroll offset WITHOUT touching the information architecture --
         master-detail stays invariant at every width per D-001, which rules out
         the reverted narrow-width drill-in.

         background-color is set (not background) so .pc-plans__rail's gradient
         background-image survives for pixel parity, while the rail gains an
         opaque base. The gradient alone is translucent, so a sticky rail without
         this would show the inbox sliding underneath it.

         max-height / border-bottom are reset because plans.css is imported
         globally by routes/adv/index.tsx and its
         "@media (max-width: 980px) .pc-plans__rail" rule -- written for the
         plans page's single-column collapse -- otherwise reaches this rail,
         which does NOT collapse. Measured: the rail computed max-height 522px
         (58vh) at both 900px and 800px windows while the inbox and detail panes
         were 800px tall, so the rail visibly stopped ~278px short of the bottom.
         Only max-height and border-bottom leak; border-right is already won back
         by this rule on document order (measured 1px at 800px). */
      .pc-advconv__nav {
        flex: 0 0 auto;
        width: 64px;
        min-height: 0;
        border-right: 1px solid var(--advconv-border);
        position: sticky;
        left: 0;
        z-index: 2;
        background-color: var(--advconv-bg);
        max-height: none;
        border-bottom: none;
      }
      .pc-advconv__nav-actions {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 10px 8px;
      }
      .pc-advconv__nav-actions .pc-plans__new-plan {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
        min-height: 40px;
        justify-content: center;
        padding: 5px;
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 44%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 84%);
      }
      .pc-advconv__nav-switcher {
        display: flex;
        flex-direction: column;
        gap: 7px;
        min-width: 0;
      }
      .pc-advconv__nav-primary {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }
      .pc-advconv__nav-diagnostic {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
        padding-top: 7px;
        border-top: 1px solid var(--advconv-border);
      }
      .pc-advconv__navbtn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        flex: 1;
        width: 40px;
        min-width: 40px;
        min-height: 40px;
        overflow: hidden;
        padding: 5px;
        /* Inactive tabs sit quiet (no box chrome) so the accent-tinted icon
           chip, the active tab, and the Ask action carry the rail's hierarchy.
           Only colors transition — geometry stays static for the webview. */
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        color: var(--fg-dim, #b9d4e8);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv__navicon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: 8px;
        color: var(--nav-accent, var(--advconv-accent-strong));
        background: color-mix(in oklab, var(--nav-accent, var(--advconv-accent)), transparent 86%);
        border: 1px solid color-mix(in oklab, var(--nav-accent, var(--advconv-accent)), transparent 72%);
      }
      .pc-advconv__navlabel {
        display: none;
      }
      .pc-advconv__navbtn:hover {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 90%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 58%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__navbtn.is-active {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 84%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 44%);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
      }
      .pc-advconv__navbtn.is-active::before {
        content: '';
        position: absolute;
        inset: 7px auto 7px 0;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--nav-accent, var(--accent));
      }
      .pc-advconv__navbtn.is-active .pc-advconv__navicon {
        background: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 72%);
        border-color: color-mix(in oklab, var(--nav-accent, var(--accent)), transparent 48%);
      }
      .pc-advconv__nav-sep {
        display: none;
      }
      .pc-advconv__navbtn--raw {
        min-height: 36px;
        color: var(--fg-mute, #7f9bb4);
        background: transparent;
        opacity: 0.78;
      }
      .pc-advconv__navbtn--raw .pc-advconv__navicon {
        width: 24px;
        height: 24px;
        flex-basis: 24px;
        border-radius: 7px;
      }
      .pc-advconv__navbtn--raw:hover,
      .pc-advconv__navbtn--raw.is-active {
        opacity: 1;
      }
      .pc-advconv__navfilters {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pc-advconv__inbox {
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-right: 1px solid var(--advconv-border);
        background: var(--advconv-panel);
      }
      /* Sidebar blurb shown for the full-width views (no rail list) so the
         sidebar isn't an empty panel below the switcher. */
      .pc-advconv__nav-hint {
        margin: 0;
        padding: 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg-mute, #7f9bb4);
        border-top: 1px solid color-mix(in srgb, var(--advconv-border), transparent 30%);
      }
      .pc-advconv__navlist {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .pc-advconv__listscroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 10px 12px;
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 35%);
      }
      .pc-advconv__main {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 8px;
      }
      .pc-advconv__back {
        display: none;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: 0 0 6px;
        padding: 0;
        border: 1px solid var(--advconv-border);
        border-radius: 8px;
        background: var(--bg-2);
        color: var(--fg-dim);
      }
      /* Full-width stream views (Raw events / Messages) render their list INSIDE
         the detail slot, so ConvFrame omits the .pc-advconv__inbox section. The
         shell is a 3-track grid (rail | list | main); with the list section gone,
         grid auto-placement dropped main into track 2 -- the 300-360px LIST track
         -- and left the 1fr track empty. That squeezed the whole system-log feed
         into a ~300px column beside a huge blank pane, which reads as "clicking a
         row in the left pane doesn't show it in the main pane" (owner-hit
         2026-07-11). Note "flex: 1 1 auto" on .pc-advconv__main is inert here
         because main is a GRID item, not a flex item -- so the placement must be
         stated explicitly. (No backticks in this comment: the whole stylesheet is
         a JS template literal.) */
      .pc-advconv__main--wide { padding: 0; grid-column: 2 / -1; }
      .pc-advconv {
        --advconv-button-accent: var(--advconv-accent);
      }
      .pc-advconv .pc-coord__chip {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 68%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 93%);
        color: var(--fg-dim, #b9d4e8);
        border-radius: 8px;
        box-shadow: none;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__chip:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 32%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 82%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv .pc-coord__chip.is-active {
        border-color: color-mix(in oklab, var(--advconv-button-accent), transparent 18%);
        background: color-mix(in oklab, var(--advconv-button-accent), transparent 66%);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__rowtags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
      .pc-advconv__refresh { margin-left: auto; display: inline-flex; align-items: center; }
      .pc-advconv__callout {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px;
        align-items: flex-start;
        margin: 6px 0;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advconv__callout > svg { margin-top: 2px; }
      .pc-advconv__callout strong {
        display: block;
        margin-bottom: 4px;
        color: var(--fg, #e7f7ff);
        font-size: 12px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__callout p {
        margin: 0;
        line-height: 1.5;
      }
      .pc-advconv__callout--accepted {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 68%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 92%);
      }
      .pc-advconv__callout--accepted > svg { color: var(--good, #22c55e); }
      .pc-advconv__callout--linked {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 70%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 93%);
      }
      .pc-advconv__callout--linked > svg { color: var(--advconv-accent-strong); }
      .pc-advconv__callout--linked p {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pc-advconv__callout--linked p span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid var(--advconv-border);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-soft);
        font-weight: 750;
      }
      .pc-advconv__callout--linked p em {
        color: var(--fg-mute, #8aa3bc);
        font-style: normal;
      }
      .pc-advconv__empty {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advconv__empty--card,
      .pc-advconv__empty--detail,
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        align-items: flex-start;
        flex-direction: column;
        justify-content: center;
        min-height: 120px;
        padding: 14px;
        border-radius: 12px;
        border: 1px dashed var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 35%);
      }
      .pc-advconv__empty--detail {
        min-height: 100%;
        align-items: center;
        text-align: center;
      }
      .pc-advconv__empty--rail,
      .pc-advconv__empty--thread {
        min-height: 88px;
        padding: 12px;
        border-radius: 10px;
      }
      .pc-advconv__empty--thread {
        min-height: 72px;
        margin-top: 4px;
      }
      .pc-advconv__empty strong { color: var(--fg, #e7f7ff); font-size: 14px; }
      .pc-advconv__empty span { max-width: 420px; line-height: 1.45; }
      .pc-advconv__empty--error {
        border-color: color-mix(in oklab, var(--bad, #f87171), transparent 60%);
        background: color-mix(in oklab, var(--bad, #f87171), transparent 94%);
      }
      .pc-advconv__empty--error strong { color: var(--bad, #f87171); }
      .pc-advconv__skeleton {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 3px 1px;
      }
      .pc-advconv__skeleton-row {
        height: 42px;
        flex: 0 0 auto;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 60%);
        background: linear-gradient(
          100deg,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 40%,
          color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 30%) 50%,
          color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 45%) 60%
        );
        background-size: 200% 100%;
        animation: pc-advconv-shimmer 1.4s ease-in-out infinite;
      }
      @keyframes pc-advconv-shimmer {
        from { background-position: 200% 0; }
        to { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .pc-advconv__skeleton-row { animation: none; }
      }
      .pc-advconv__reply {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 9px;
        border-radius: 10px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
      }
      .pc-advconv__replyhead {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__replyhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__replyhead em {
        max-width: 410px;
        text-align: right;
        font-style: normal;
        line-height: 1.35;
      }
      .pc-advconv__reply textarea {
        width: 100%; resize: vertical; min-height: 48px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 18%); color: var(--fg, #e7f7ff);
        border: 1px solid var(--advconv-border);
        border-radius: 8px; padding: 8px 9px; font: inherit; font-size: 12px;
        box-shadow: none;
      }
      .pc-advconv__reply textarea:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 2px; }
      .pc-advconv__replyactions { justify-content: flex-end; }
      .pc-advconv .pc-coord__actions button,
      .pc-advconv__replybtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        padding: 5px 10px;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 64%);
        border-radius: 8px;
        background: color-mix(in oklab, var(--advconv-accent), transparent 90%);
        color: var(--fg, #e7f7ff);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-advconv .pc-coord__actions button:hover:not(:disabled),
      .pc-advconv__replybtn:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 30%);
        background: color-mix(in oklab, var(--advconv-accent), transparent 64%);
      }
      .pc-advconv .pc-coord__actions button:disabled,
      .pc-advconv__replybtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .pc-advconv__replybtn--resolve:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
        color: var(--fg, #e7f7ff);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 90%);
      }
      .pc-advconv__replybtn--resolve:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 30%);
        background: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
      }

      /* The selected item's detail fills the main pane (it keeps its
         .pc-coord__detail / .pc-coord__card content; the frame is now the
         shell's main column, not a 2-pane split column). */
      .pc-advconv__main .pc-coord__detail {
        flex: 1 1 auto;
        min-height: 0;
        /* Neutralize coordination.css's .pc-coord__detail cap (max-height:74vh +
           a grey border-left + padding-left). The pre-restructure CSS overrode
           these; dropping that override let the detail get capped at 74vh, which
           left a dead gap below the card — the reported glitch. */
        max-height: none;
        overflow-y: auto;
        border: 1px solid var(--advconv-border);
        border-left: 1px solid var(--advconv-border);
        border-radius: 12px;
        background: var(--advconv-panel);
        backdrop-filter: none;
        padding: 14px;
        box-shadow: none;
      }
      /* Thin, theme-tinted scrollbars on the tab's scroll surfaces — the default
         wide gutter reads heavy against the compact rail cards. */
      .pc-advconv__listscroll,
      .pc-advconv__main .pc-coord__detail,
      .pc-advfeed__stream,
      .pc-advfeed__detailpane {
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 55%) transparent;
      }
      .pc-advconv__railhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 1px 6px;
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__railhead strong {
        display: inline-flex;
        min-width: 28px;
        justify-content: center;
        border-radius: 999px;
        padding: 2px 7px;
        color: var(--fg, #e7f7ff);
        background: var(--advconv-accent-soft);
        border: 1px solid var(--advconv-border);
      }
      .pc-advconv__railhead--unified {
        justify-content: flex-start;
      }
      .pc-advconv__railhead--unified strong {
        margin-left: auto;
      }
      .pc-advconv__unified-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .pc-advconv__unified-search {
        display: flex;
        flex: 1 1 190px;
        min-width: 0;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 0 8px;
        border: 1px solid var(--advconv-border);
        border-radius: 8px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 16%);
        color: var(--fg-mute);
        transition: border-color 120ms ease;
      }
      .pc-advconv__unified-search:focus-within {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 40%);
        outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 76%);
        outline-offset: 1px;
      }
      .pc-advconv__unified-search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-size: 11.5px;
      }
      .pc-advconv__unified-tools .pc-advpanel__filterbar {
        flex: 0 1 auto;
        min-width: 0;
      }
      /* facets layout: drop onto its own full-width line below the search, so
         the always-visible facet chips have room to wrap. */
      .pc-advconv__unified-tools .pc-advpanel__filterbar--facets {
        flex: 1 1 100%;
        padding: 2px 0 0;
        row-gap: 6px;
        column-gap: 10px;
      }
      .pc-advconv__unified-reset {
        flex: 0 0 auto;
      }
      .pc-advconv__unified {
        padding: 8px;
      }
      .pc-advconv__virtual-list {
        position: relative;
        width: 100%;
      }
      .pc-advconv__unified-row {
        position: absolute;
        left: 0;
        right: 0;
        width: 100%;
        height: ${Xe}px;
        overflow: clip;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        gap: 9px;
        align-items: start;
        padding: 9px;
        border: 1px solid transparent;
        border-bottom-color: color-mix(in srgb, var(--advconv-border), transparent 45%);
        border-radius: 10px;
        background: transparent;
        color: var(--fg);
        text-align: left;
        cursor: pointer;
        /* Color-only transitions: top stays untransitioned so virtual-list
           reorders snap instead of animating (the WebKit flash guard above).
           (No backticks here: the stylesheet is a JS template literal.) */
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      .pc-advconv__unified-row:hover,
      .pc-advconv__unified-row:focus-visible,
      .pc-advconv__unified-row.is-active {
        background: var(--advconv-accent-softer);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
      }
      .pc-advconv__unified-row.is-active {
        background: var(--advconv-accent-soft);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 42%);
      }
      .pc-advconv__unified-row.is-active::before {
        content: '';
        position: absolute;
        inset: 9px auto 9px 0;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--advconv-accent);
      }
      .pc-advconv__unified-row:focus-visible {
        outline: 1px solid var(--advconv-accent);
        outline-offset: -1px;
      }
      /* The icon chip carries the SAME per-source accent as the type pill, so
         the rail is scannable by color before any text is read. */
      .pc-advconv__unified-source {
        --type-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 1px solid color-mix(in oklab, var(--type-accent), transparent 72%);
        border-radius: 9px;
        background: color-mix(in oklab, var(--type-accent), transparent 87%);
        color: color-mix(in oklab, var(--type-accent), white 28%);
      }
      .pc-advconv__unified-source--threads { --type-accent: var(--accent-strong); }
      .pc-advconv__unified-source--deliberations { --type-accent: #a78bfa; }
      .pc-advconv__unified-source--agentchats { --type-accent: #f472b6; }
      .pc-advconv__unified-content {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .pc-advconv__unified-topline,
      .pc-advconv__unified-meta {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--fg-mute);
        font-size: 10px;
      }
      .pc-advconv__unified-topline time {
        margin-left: auto;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv__unified-kind {
        --type-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        max-width: 170px;
        overflow: hidden;
        padding: 1px 6px;
        border: 1px solid color-mix(in oklab, var(--type-accent), transparent 64%);
        border-radius: 999px;
        background: color-mix(in oklab, var(--type-accent), transparent 88%);
        color: color-mix(in oklab, var(--type-accent), white 34%);
        font-weight: 750;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-advconv__unified-kind--threads { --type-accent: var(--accent-strong); }
      .pc-advconv__unified-kind--deliberations { --type-accent: #a78bfa; }
      .pc-advconv__unified-kind--agentchats { --type-accent: #f472b6; }
      .pc-advconv__unified-content > strong {
        min-width: 0;
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        color: var(--fg);
        font-size: 13px;
        line-height: 1.35;
      }
      .pc-advconv__unified-preview {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-dim);
        font-size: 11.5px;
        line-height: 1.35;
      }
      .pc-advconv__unified-meta {
        overflow: hidden;
        white-space: nowrap;
        font-size: 10.5px;
      }
      .pc-advconv__unified-meta span {
        min-width: 0;
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-advconv .pc-coord__row {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 3px;
        padding: 7px 9px;
        border-radius: 8px;
        border-color: color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 48%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 38%);
        cursor: pointer;
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advconv .pc-coord__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advconv .pc-coord__row.is-active {
        background: var(--advconv-accent-soft);
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 42%);
        box-shadow: none;
      }
      .pc-advconv .pc-coord__row.is-active::before {
        content: '';
        position: absolute;
        inset: 8px auto 8px -1px;
        width: 3px;
        border-radius: 0 999px 999px 0;
        background: var(--advconv-accent);
      }
      .pc-advconv__threadtop {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advconv__statepill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 18px;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv__statepill--open {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 58%);
        background: var(--advconv-good-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--open::before,
      .pc-advconv__statepill--resolved::before,
      .pc-advconv__statepill--closed::before,
      .pc-advconv__statepill--delivered::before,
      .pc-advconv__statepill--sent::before,
      .pc-advconv__statepill--read::before {
        content: '';
        width: 5px;
        height: 5px;
        flex: 0 0 5px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.9;
      }
      .pc-advconv__statepill--resolved {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__statepill--closed {
        border-color: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 80%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 48%);
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advconv__statepill--delivered,
      .pc-advconv__statepill--sent,
      .pc-advconv__statepill--read {
        border-color: color-mix(in oklab, var(--good, #22c55e), transparent 64%);
        background: var(--advconv-good-soft);
        color: var(--good, #22c55e);
      }
      /* Kind pill — bring the coordination.css base (a square, hardcoded-#9bd chip)
         in line with the site's rounded, semantic-token pills (StatusPill family).
         Question is accent-tinted so it pops against neutral discussions/roles in
         the thread rail. */
      .pc-advconv .pc-coord__kind {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 72%);
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4), transparent 90%);
        color: var(--fg-dim, #b9d4e8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advconv .pc-coord__kind--question {
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 56%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%);
        color: var(--accent-strong, #7dd3fc);
      }
      /* Topic tags — subtle accent pills (was the hardcoded-#9bd .pc-coord__tag). */
      .pc-advconv .pc-coord__tag {
        display: inline-flex;
        align-items: center;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 80%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%);
        color: var(--accent-strong, #7dd3fc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advconv__rowdate {
        margin-left: auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #6f87a0);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
    .pc-advconv .pc-coord__row-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
      letter-spacing: 0;
    }
      .pc-advconv .pc-coord__row-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
      }
      .pc-advconv .pc-coord__card {
        min-height: 100%;
        padding: 2px;
      }
      .pc-advconv__detailhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        padding: 0 0 10px;
        border-bottom: 1px solid var(--advconv-border);
      }
      .pc-advconv__detailkicker {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 0 0 5px;
      }
      .pc-advconv .pc-coord__card header h2 {
        font-size: 20px;
        /* line-height 1 clipped descenders and set wrapped long titles solid;
           1.25 keeps multi-line titles readable without loosening the header. */
        line-height: 1.25;
        letter-spacing: 0;
      }
      .pc-advconv__detailstats {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        max-width: 340px;
      }
      .pc-advconv__detailstats span {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 2px 6px;
        border-radius: 8px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #9fb6cc);
        font-size: 11px;
      }
      .pc-advconv__detailstats strong {
        color: var(--fg, #e7f7ff);
        font-variant-numeric: tabular-nums;
      }
      .pc-advconv .pc-coord__thread li {
        position: relative;
        border-left-color: color-mix(in oklab, var(--advconv-accent), transparent 62%);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        border-radius: 0 8px 8px 0;
        padding: 8px 10px;
      }
      .pc-advconv .pc-coord__thread li::before {
        content: "";
        position: absolute;
        left: -5px;
        top: 16px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advconv__postmeta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advconv__postmeta strong {
        color: var(--fg, #e7f7ff);
      }
      .pc-advconv__postmeta span {
        font-variant-numeric: tabular-nums;
        color: var(--fg-mute, #7f9bb4);
      }

      /* Agent-chat transcript — role-differentiated turns */
      .pc-advconv__transcript {
        gap: 9px;
      }
      /* WI-125 live-chat embed: <ChatPanel> sizes itself with flex, so the
         wrapper must hand it a definite box (same WebKitGTK height-collapse
         gotcha as the dock — see HarnessesDock). */
      .pc-advconv__livechat {
        display: flex;
        height: min(64vh, 680px);
        min-height: 320px;
        border: 1px solid var(--advconv-border);
        border-radius: 10px;
        overflow: hidden;
      }
      .pc-advconv__livechat > * {
        flex: 1;
        min-width: 0;
      }
      .pc-advconv__turn p {
        margin: 4px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg, #d7e7f4);
      }
      .pc-advconv__turn--user::before {
        background: var(--accent-strong, #7dd3fc) !important;
      }
      .pc-advconv__turn--assistant::before {
        background: var(--good, #6ee7b7) !important;
      }
      .pc-advconv__turn--system::before {
        background: var(--fg-mute, #8aa3bc) !important;
      }
      .pc-advconv__turn--system p {
        color: var(--fg-mute, #9fb6cd);
        font-style: italic;
      }

      /* Feed */
      .pc-advfeed { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
      .pc-advfeed__filters {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 6px 8px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--bg, #07101d), transparent 12%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 88%);
      }
      .pc-advfeed__filterhead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 2px 2px;
        color: var(--fg-mute, #8aa3bc);
        font-size: 11px;
      }
      .pc-advfeed__filterhead > div:first-child {
        min-width: 0;
      }
      .pc-advfeed__filterhead span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--fg, #e7f7ff);
        font-weight: 850;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__filterhead p { display: none; }
      .pc-advfeed__filtermeta {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__filtermeta strong,
      .pc-advfeed__filtermeta span,
      .pc-advfeed__needsline strong {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .pc-advfeed__filtermeta span {
        background: transparent;
        color: var(--fg-mute, #9fb6cc);
      }
      .pc-advfeed__needsline {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding: 0;
      }
      .pc-advfeed__needsline span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
        padding: 3px 7px;
        border-radius: 7px;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 93%);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__needsline strong {
        margin-left: auto;
      }
      .pc-advfeed__kindgroups {
        gap: 4px;
      }
      .pc-advfeed__groupchip,
      .pc-advfeed__advancedtoggle {
        --advconv-button-accent: var(--advconv-accent);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 28px;
        padding: 4px 8px;
        border-radius: 7px;
        font-size: 11px;
        font-weight: 700;
      }
      .pc-advfeed__advancedtoggle { --advconv-button-accent: var(--accent); }
      .pc-advfeed__rawkinds {
        padding-top: 2px;
      }
      .pc-advfeed__kindchip {
        --advconv-button-accent: var(--fg-mute, #94a3b8);
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 26px;
        padding: 3px 7px;
        border-radius: 7px;
        font-size: 10.5px;
        font-weight: 700;
      }
      .pc-advfeed__kinddot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .pc-advfeed__kindn {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.8;
        background: color-mix(in srgb, var(--bg-3, rgba(255, 255, 255, 0.075)), transparent 20%); border-radius: 6px; padding: 0 4px; margin-left: 2px;
      }
      .pc-advfeed__inputs { display: flex; gap: 5px; flex-wrap: wrap; align-items: flex-end; }
      .pc-advfeed__field {
        display: flex;
        flex-direction: column;
        gap: 3px;
        flex: 0 1 142px;
        min-width: 118px;
        max-width: 150px;
      }
      .pc-advfeed__field > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--fg-mute, #7890a8);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__field--search {
        flex: 0 1 220px;
        max-width: 240px;
      }
      .pc-advfeed__input {
        width: 100%;
        height: 28px;
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
        color: var(--fg, #e7f7ff);
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        border-radius: 8px;
        padding: 4px 7px;
        font: inherit;
        font-size: 11.5px;
        min-width: 0;
      }
      .pc-advfeed__input::placeholder { color: color-mix(in srgb, var(--accent-soft, #94a3b8), transparent 60%); }
      .pc-advfeed__input:focus { outline: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 66%); outline-offset: 1px; }
      .pc-advfeed__clear { min-height: 28px; }
      .pc-advfeed__scopebar {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
        padding-top: 2px;
        font-size: 11px;
        color: var(--fg-mute, #8aa3bc);
      }
      .pc-advfeed__scopebar > span {
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-advfeed__scopebar strong {
        display: inline-flex;
        align-items: center;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 2px 7px;
        border-radius: 7px;
        border: 1px solid var(--advconv-border);
        background: var(--advconv-accent-soft);
        color: var(--fg, #e7f7ff);
        font-weight: 700;
      }

      .pc-advfeed__stream {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 3px 1px 8px;
      }
      .pc-advfeed__daysep {
        position: sticky; top: 0; z-index: 1;
        font-size: 10px; letter-spacing: 0; text-transform: uppercase;
        color: var(--fg-mute, #7890a8); padding: 4px 2px 1px;
        background: linear-gradient(var(--advconv-bg), color-mix(in srgb, var(--advconv-bg), transparent 18%));
      }
      .pc-advfeed__daysep span {
        display: inline-flex;
        padding: 2px 7px;
        border-radius: 7px;
        background: var(--advconv-accent-softer);
        border: 1px solid var(--advconv-border);
      }
      .pc-advfeed__item { border-radius: 6px; }
      .pc-advfeed__item.is-open { background: var(--advconv-accent-softer); }
      .pc-advfeed__row {
        width: 100%; display: grid;
        grid-template-columns: auto auto minmax(120px, 1fr) minmax(0, 2fr) auto auto auto;
        align-items: center; gap: 6px; text-align: left;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
        font-size: 12px; color: var(--fg, #dceaf6);
        border: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 58%);
        border-radius: 8px;
        transition: background-color 140ms, border-color 140ms;
      }
      .pc-advfeed__row:hover {
        background: var(--advconv-accent-softer);
        border-color: var(--advconv-border);
      }
      .pc-advfeed__item.is-open .pc-advfeed__row {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: var(--advconv-accent-soft);
      }
      /* ── Master/detail (WI-4216, owner 2026-07-12 "make it work just like
         the curated Conversations pane"). The feed renders inside ConvFrame's
         list rail (compact clickable rows) + main detail pane (the opened
         message), instead of a full-width inline-expand stream. ── */
      .pc-advfeed__item.is-active .pc-advfeed__row {
        border-color: color-mix(in oklab, var(--advconv-accent), transparent 25%);
        background: var(--advconv-accent-soft);
        box-shadow: inset 2px 0 0 0 var(--advconv-accent);
      }
      /* In the ~320px list rail, wrap the horizontal 7-col row into a compact
         stacked card so the summary is readable, not squeezed into a sliver. */
      .pc-advconv__navlist .pc-advfeed__row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 3px 6px;
      }
      .pc-advconv__navlist .pc-advfeed__rel { order: 3; margin-left: auto; }
      .pc-advconv__navlist .pc-advfeed__route { order: 4; min-width: 0; flex-wrap: wrap; }
      .pc-advconv__navlist .pc-advfeed__summary {
        order: 5;
        flex: 1 1 100%;
        white-space: normal;
        text-overflow: clip;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .pc-advconv__navlist .pc-advfeed__planchip { order: 6; }
      .pc-advconv__navlist .pc-advfeed__replyn { order: 7; }
      /* Detail-pane instance: full width, always-expanded, non-interactive header. */
      .pc-advfeed__detailpane { overflow-y: auto; padding: 10px 12px; min-height: 0; }
      .pc-advfeed__item--detail { background: transparent; }
      .pc-advfeed__item--detail .pc-advfeed__row { cursor: default; }
      .pc-advfeed__item--detail .pc-advfeed__summary { white-space: normal; cursor: default; }
      .pc-advfeed__time { font-variant-numeric: tabular-nums; font-size: 10px; color: var(--fg-mute, #7890a8); }
      .pc-advfeed__badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 7px;
        border: 1px solid currentColor; background: color-mix(in srgb, currentColor 12%, transparent);
        white-space: nowrap; text-transform: lowercase;
      }
      .pc-advfeed__badge > span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--feed-kind-color, currentColor);
        box-shadow: none;
      }
      .pc-advfeed__badge--sm { font-size: 10px; padding: 0 5px; }
      .pc-advfeed__route { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 10.5px; }
      .pc-advfeed__from {
        border: none; background: none; color: var(--fg, #cfe8ff); font: inherit; font-size: 10.5px;
        font-weight: 600; cursor: pointer; padding: 0; max-width: 120px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-advfeed__from:hover { text-decoration: underline; }
      .pc-advfeed__to { color: var(--fg-mute, #8aa3bc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
      .pc-advfeed__to--broadcast { color: var(--advconv-accent-strong); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__to--human { color: var(--warn, #f59e0b); font-weight: 600; display: inline-flex; align-items: center; gap: 3px; }
      .pc-advfeed__summary {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg, #dceaf6);
        border: none; background: none; font: inherit; font-size: 11.5px; text-align: left;
        cursor: pointer; padding: 0; min-width: 0;
      }
      .pc-advfeed__summary:hover { color: var(--fg, #e7f7ff); }
      .pc-advfeed__nosum { color: var(--fg-mute, #5f7488); }
      .pc-advfeed__planchip {
        font-size: 10px; padding: 1px 6px; border-radius: 7px; white-space: nowrap;
        border: 1px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        color: var(--advconv-accent-strong);
        background: var(--advconv-accent-softer);
        cursor: pointer; font: inherit;
      }
      .pc-advfeed__planchip:hover { background: var(--advconv-accent-soft); }
      .pc-advfeed__replyn { font-size: 10px; color: var(--fg-mute, #8aa3bc); white-space: nowrap; }
      .pc-advfeed__rel { font-size: 10px; color: var(--fg-mute, #6f87a0); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-advfeed__detail {
        margin: 0 6px 3px 28px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 11.5px;
        border: 1px solid var(--advconv-border);
        border-left: 2px solid color-mix(in oklab, var(--advconv-accent), transparent 58%);
        background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 18%);
        border-radius: 0 8px 8px 0;
        box-shadow: none;
      }
      .pc-advfeed__detailhead {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }
      .pc-advfeed__detailhead span {
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 6px;
        border-radius: 7px;
        border: 1px solid var(--advconv-border);
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 34%);
        color: var(--fg-mute, #8aa3bc);
        font-size: 10px;
        font-weight: 700;
      }
      .pc-advfeed__bodycard,
      .pc-advfeed__kv {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 82%);
        background: color-mix(in srgb, var(--bg-deeper, #040b14), transparent 15%);
      }
      .pc-advfeed__bodycard strong,
      .pc-advfeed__kv strong {
        display: block;
        margin-bottom: 3px;
        color: var(--fg, #e7f7ff);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .pc-advfeed__body { white-space: pre-wrap; color: var(--fg, #dceaf6); margin: 0; line-height: 1.42; }
      .pc-advfeed__kv { color: var(--fg-mute, #9fb6cc); margin: 0; }
      .pc-advfeed__kv span { color: var(--fg-mute, #b6c8d8); line-height: 1.45; }
      .pc-advfeed__kv--action {
        border-color: color-mix(in oklab, var(--warn, #f59e0b), transparent 70%);
        background: color-mix(in oklab, var(--warn, #f59e0b), transparent 93%);
      }
      .pc-advfeed__kv--action strong { color: var(--warn, #f59e0b); }
      .pc-advfeed__thread {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-advfeed__thread li {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 6px 8px;
        padding: 6px 8px 6px 2px;
        font-size: 10.5px;
      }
      .pc-advfeed__threadrail {
        width: 9px;
        height: 9px;
        margin-top: 4px;
        border-radius: 50%;
        background: var(--advconv-accent);
        box-shadow: none;
      }
      .pc-advfeed__threadmeta {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .pc-advfeed__threadmeta strong { color: var(--fg, #e7f7ff); font-size: 10.5px; }
      .pc-advfeed__threadmeta em { color: var(--fg-mute, #6f87a0); font-style: normal; margin-left: auto; white-space: nowrap; }
      .pc-advfeed__threadsum {
        grid-column: 2;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg-mute, #aebfd0);
      }
      .pc-advfeed__loadolder {
        margin: 5px auto; padding: 5px 12px; border-radius: 7px; font-size: 11px; cursor: pointer;
        border: 1px solid var(--border, rgba(125,211,252,0.2)); background: transparent; color: var(--fg-mute, #9fb6cc); font: inherit;
      }
      .pc-advfeed__loadolder:hover { color: var(--fg, #e7f7ff); border-color: var(--advconv-border-strong); background: var(--advconv-accent-soft); }
      .pc-advfeed__refresh { flex: 0 0 auto; }
      @media (max-width: 920px) {
        /* Desktop master-detail is invariant at every supported window size:
           selecting a row updates the right pane and never replaces the left
           inbox. Narrow windows scroll horizontally instead of changing the
           information architecture underneath the user. */
        .pc-advconv__detailhead { flex-direction: column; }
        .pc-advconv__detailstats { justify-content: flex-start; max-width: none; }
        .pc-advconv__replyhead { flex-direction: column; }
        .pc-advconv__replyhead em { max-width: none; text-align: left; }
        .pc-advfeed__refresh { justify-content: center; }
        .pc-advfeed__row {
          grid-template-columns: auto auto minmax(0, 1fr) auto;
        }
        .pc-advfeed__summary {
          grid-column: 3 / -1;
        }
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
      }
      @media (max-width: 620px) {
        .pc-advconv__nav-actions { padding: 7px 8px; gap: 5px; }
        .pc-advconv__nav-actions .pc-plans__new-plan,
        .pc-advconv__navbtn,
        .pc-advconv__navbtn--raw {
          min-width: 40px;
          width: 40px;
          min-height: 40px;
          justify-content: center;
          padding: 5px;
        }
        .pc-advconv__navlabel { display: none; }
        .pc-advconv__navicon,
        .pc-advconv__navbtn--raw .pc-advconv__navicon {
          width: 28px;
          height: 28px;
          flex-basis: 28px;
        }
        .pc-advconv__main { padding: 6px; }
        .pc-advconv__main--wide { padding: 0; }
        .pc-advconv__main .pc-coord__detail { border-radius: 10px; padding: 9px; }
        .pc-advfeed__filterhead,
        .pc-advfeed__filtermeta,
        .pc-advfeed__needsline {
          align-items: stretch;
          flex-direction: column;
        }
        .pc-advfeed__needsline strong { margin-left: 0; }
        .pc-advfeed__inputs { flex-direction: column; }
        .pc-advfeed__field,
        .pc-advfeed__field--search {
          width: 100%;
          max-width: none;
        }
        .pc-advfeed__clear { width: 100%; justify-content: center; }
        .pc-advfeed__row {
          grid-template-columns: auto minmax(0, 1fr);
          gap: 6px;
        }
        .pc-advfeed__time,
        .pc-advfeed__badge,
        .pc-advfeed__route,
        .pc-advfeed__summary,
        .pc-advfeed__planchip,
        .pc-advfeed__replyn,
        .pc-advfeed__rel {
          grid-column: auto;
        }
        .pc-advfeed__summary { grid-column: 1 / -1; }
        .pc-advfeed__detail { margin-left: 8px; }
      }
    `})}export{Ta as composeUnifiedConversationRows,Bn as default,$n as isSystemConversationActor};
