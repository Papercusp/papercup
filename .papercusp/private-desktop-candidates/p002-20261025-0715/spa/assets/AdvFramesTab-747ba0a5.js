import{o as q}from"./chunk-a1a4177d.js";import{t as G}from"./react-ea1d8b8b.js";import{n as J,t as Q}from"./preload-helper-9c81c42c.js";import{t as X}from"./jsx-runtime-660d4162.js";import{i as Y}from"./SyncContext-10c8fc40.js";import{r as Z}from"./resilient-event-source-e88908f6.js";import{l as C,o as ee,r as V}from"./dist-8935d6c3.js";import{t as K}from"./createLucideIcon-7dfd863d.js";import{t as A}from"./eye-8affca81.js";import{t as D}from"./monitor-play-f782da48.js";import{t as ae}from"./refresh-cw-d4dbdc1a.js";import{t as re}from"./x-c15b3066.js";import{t as P}from"./Tooltip-98086d04.js";import{n as te}from"./useLexicon-e47d5e4a.js";import{i as se,t as ne}from"./desktop-video-client-60884cad.js";var oe=[["path",{d:"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2",key:"1fvzgz"}],["path",{d:"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",key:"1kc0my"}],["path",{d:"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8",key:"10h0bg"}],["path",{d:"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",key:"1s1gnw"}]],O=K("hand",oe),ie=[["path",{d:"M12 17v4",key:"1riwvh"}],["path",{d:"M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 1.184-1.826",key:"cv7jms"}],["path",{d:"m2 2 20 20",key:"1ooewy"}],["path",{d:"M8 21h8",key:"1ev6f3"}],["path",{d:"M8.656 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-.293 1.042",key:"z8ni2w"}]],ce=K("monitor-off",ie),t=q(G(),1),e=X();J();function le({slug:p,display:s,drive:j,target:N="frame",onState:v}){const $=(0,t.useRef)(null),[m,h]=(0,t.useState)("connecting"),[u,y]=(0,t.useState)(null);return(0,t.useEffect)(()=>{let _=!1,f;const S=i=>{_||(h(i),v?.(i))};return S("connecting"),(async()=>{try{const i=await fetch(`/api/deploy/${encodeURIComponent(p)}/vnc-session`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({display:s,mode:j?"takeover":"watch",target:N})}),l=await i.json();if(!i.ok||!l.ok||!l.wsUrl)throw new Error(l.error??`HTTP ${i.status}`);if(_||!$.current)return;const{default:x}=await Q(async()=>{const{default:o}=await import("./rfb-b8bc761b.js");return{default:o}},[]);f=new x($.current,l.wsUrl),f.viewOnly=!j,f.scaleViewport=!0,f.background=getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()||"#07101d",f.addEventListener("connect",()=>S("connected")),f.addEventListener("disconnect",()=>S("ended"))}catch(i){_||(y((i instanceof Error?i.message:String(i)).slice(0,200)),S("error"))}})(),()=>{_=!0;try{f?.disconnect()}catch{}}},[p,s,j,N,v]),(0,e.jsxs)("div",{className:"pc-frame-vnc","data-state":m,children:[(0,e.jsx)("div",{ref:$,className:"pc-frame-vnc__screen"}),m!=="connected"&&(0,e.jsxs)("div",{className:"pc-frame-vnc__overlay",children:[m==="connecting"&&"Connecting to the frame…",m==="ended"&&"Live session ended.",m==="error"&&`Live view failed: ${u}`]}),(0,e.jsx)("style",{children:`
        .pc-frame-vnc { position: relative; flex: 1; min-height: 0; display: flex; }
        .pc-frame-vnc__screen { flex: 1; min-height: 0; }
        .pc-frame-vnc__screen > div { width: 100%; height: 100%; }
        .pc-frame-vnc__overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--fg-mute, #7f9bb4);
          background: rgb(from var(--bg, #07101d) r g b / 0.6);
          pointer-events: none;
        }
      `})]})}var pe=8e3;function de({slug:p,display:s,onUnavailable:j}){const N=(0,t.useRef)(null),[v,$]=(0,t.useState)(!1),m=(0,t.useRef)(!1),h=(0,t.useCallback)(u=>{m.current||(m.current=!0,j(u))},[j]);return(0,t.useEffect)(()=>{let u=!1,y,_,f=!1;const S=`frame:${p}:${s}`;let i=null;return(async()=>{if(!se()){h("WebCodecs unavailable in this webview");return}try{const l=(await(await fetch("/api/agent-tools/voice/status",{method:"POST",headers:{"content-type":"application/json"},body:"{}",cache:"no-store"})).json())?.status?.channel?.id??null;if(l&&l!==`vid-${p}`){h(`operator is in voice channel '${l}' — not switching it`);return}}catch{}u||(y=ne({harness:p,onStatus:l=>{i=l.peers.find(x=>x.label===S)?.id??null},onPeerFrame:(l,x)=>{if(l!==i){x.close();return}f=!0,v||$(!0);const o=x,w=N.current;try{const d=w?.getContext("2d");d&&w&&(o.displayWidth&&o.displayHeight&&(w.width=o.displayWidth,w.height=o.displayHeight),d.drawImage(x,0,0,w.width,w.height))}finally{x.close()}},onError:()=>h("video channel error")}),_=setTimeout(()=>{!u&&!f&&h("no screen track for this display (frame not publishing?)")},pe))})(),()=>{u=!0,_&&clearTimeout(_);try{y?.close()}catch{}}},[p,s,h]),(0,e.jsxs)("div",{className:"pc-frame-track","data-streaming":v,children:[(0,e.jsx)("canvas",{ref:N,className:"pc-frame-track__canvas"}),!v&&(0,e.jsx)("div",{className:"pc-frame-track__overlay",children:"Tuning to the screen track…"}),(0,e.jsx)("style",{children:`
        .pc-frame-track { position: relative; flex: 1; min-height: 0; display: flex; background: #000; }
        .pc-frame-track__canvas { flex: 1; min-height: 0; width: 100%; height: 100%; object-fit: contain; }
        .pc-frame-track__overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: var(--fg-mute, #7f9bb4);
          background: rgba(7, 16, 29, 0.6);
          pointer-events: none;
        }
      `})]})}var fe=2e4,H=(p,s)=>`${p}:${s}`,B="/desktops?desktopHost=local";function Me(){const p=te(),[s,j]=(0,t.useState)([]),[N,v]=(0,t.useState)(null),[$,m]=(0,t.useState)(!1);(0,t.useEffect)(()=>{let a=!1;const r=()=>{fetch("/api/deploy/frames",{cache:"no-store"}).then(n=>n.ok?n.json():Promise.reject(new Error(`HTTP ${n.status}`))).then(n=>{a||(j(Array.isArray(n?.frames)?n.frames:[]),v(null),m(!0))}).catch(n=>{a||(v(String(n?.message??n)),m(!0))})};r();const c=setInterval(r,3e4);return()=>{a=!0,clearInterval(c)}},[]);const h=Y({queryName:"desktops.local"}),u=h.error?0:h.data?.length??0,[y,_]=(0,t.useState)(()=>new Map),[f,S]=(0,t.useState)(()=>new Map),i=(0,t.useRef)(new Map),l=(0,t.useMemo)(()=>s.map(a=>a.slug).sort().join(","),[s]);(0,t.useEffect)(()=>{const a=new Set(l?l.split(","):[]),r=i.current;for(const[c,n]of r)a.has(c)||(n.close(),r.delete(c));for(const c of a)r.has(c)||r.set(c,Z({url:`/api/deploy/${encodeURIComponent(c)}/frame-view`,withCredentials:!0,handlers:{thumb:n=>{try{const b=JSON.parse(n);_(z=>new Map(z).set(H(b.slug,b.display),b))}catch{}},status:n=>{try{const b=JSON.parse(n);S(z=>new Map(z).set(b.slug,b))}catch{}}}}))},[l]),(0,t.useEffect)(()=>()=>{for(const a of i.current.values())a.close();i.current.clear()},[]);const[,x]=(0,t.useState)(0);(0,t.useEffect)(()=>{const a=setInterval(()=>x(r=>r+1),2e3);return()=>clearInterval(a)},[]);const[o,w]=C("frame",ee),[d,F]=C("live",V.withDefault(!1)),[g,R]=C("drive",V.withDefault(!1)),k=(0,t.useMemo)(()=>{if(!o)return;const a=o.lastIndexOf(":");if(a<=0)return;const r=Number(o.slice(a+1));if(Number.isInteger(r))return{slug:o.slice(0,a),display:r}},[o]),M=(0,t.useMemo)(()=>o?y.get(o):void 0,[o,y]),W=async()=>{await R(null),await F(null),await w(null)},[T,I]=(0,t.useState)(null);(0,t.useEffect)(()=>{I(null)},[o,d,g]);const E=(0,t.useMemo)(()=>{const a=[...y.values()];return a.sort((r,c)=>r.slug.localeCompare(c.slug)||r.display-c.display),a},[y]),L=Date.now();return(0,e.jsxs)("div",{className:"pc-frames",children:[(0,e.jsxs)("div",{className:"pc-frames__topbar",children:[(0,e.jsx)(D,{size:14,"aria-hidden":!0}),(0,e.jsxs)("span",{className:"pc-frames__title",children:[p("fleet")," live view"]}),(0,e.jsx)("span",{className:"pc-frames__sub",children:s.length===0?"no deployed frames":`${s.length} frame${s.length===1?"":"s"} · ${E.length} live display${E.length===1?"":"s"}`}),(0,e.jsx)("div",{className:"pc-frames__spacer"}),(0,e.jsxs)("a",{className:"pc-frames__local-link",href:B,children:[u>0?`${u} agent desktop${u===1?"":"s"} on this computer`:"Desktops on this computer"," ","→"]})]}),N?(0,e.jsx)("div",{className:"pc-frames__state","data-error":"true",children:N}):$?s.length===0?(0,e.jsxs)("div",{className:"pc-frames__state",children:["No deployed frames. Deploy a harness with ",(0,e.jsx)("code",{children:"deployment.desktop: true"})," and its screens appear here. Agent desktops on this computer are on the"," ",(0,e.jsx)("a",{href:B,children:"Desktops page"}),"."]}):(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("div",{className:"pc-frames__statusrow",children:s.map(a=>{const r=f.get(a.slug),c=r?.state==="polling"&&(r.displays?.length??0)>0,n=r?.viewers??[],b=n.some(z=>z.mode==="takeover");return(0,e.jsxs)("span",{className:"pc-frames__chip","data-live":c,title:r?.error??r?.host??a.frame.host??"",children:[(0,e.jsx)("span",{className:"pc-frames__chip-dot","data-state":r?.state??"connecting","aria-hidden":!0}),a.slug,(0,e.jsx)("span",{className:"pc-frames__chip-meta",children:a.desktop?r?.state==="error"?"unreachable":r?.state==="no-frame"?"no frame":c?`${r?.displays?.length} active`:"idle":"no desktop"}),n.length>0&&(0,e.jsxs)("span",{className:"pc-frames__chip-watch","data-drive":b,title:b?"a human is DRIVING a display":"a human is watching (read-only)",children:[b?(0,e.jsx)(O,{size:10,"aria-hidden":!0}):(0,e.jsx)(A,{size:10,"aria-hidden":!0}),n.length]})]},a.slug)})}),E.length===0?(0,e.jsxs)("div",{className:"pc-frames__state",children:[(0,e.jsx)(ce,{size:14,"aria-hidden":!0})," No active displays — agents aren't driving a GUI right now. Tiles appear when an agent opens something on its display."]}):(0,e.jsx)("div",{className:"pc-frames__grid",children:E.map(a=>{const r=H(a.slug,a.display),c=L-a.capturedAtMs;return(0,e.jsx)(P,{label:`${a.slug} :${a.display}${a.role?` — ${a.role}`:""}`,children:(0,e.jsxs)("button",{type:"button",className:"pc-frames__tile","data-selected":o===r,"data-stale":c>fe,"aria-label":`${a.slug} :${a.display}${a.role?` — ${a.role}`:""}`,onClick:()=>{w(o===r?null:r)},children:[(0,e.jsx)("img",{src:`data:image/jpeg;base64,${a.jpegBase64}`,alt:`${a.slug} display :${a.display}`}),(0,e.jsxs)("span",{className:"pc-frames__tile-meta",children:[(0,e.jsx)("span",{className:"pc-frames__tile-slug",children:a.slug}),(0,e.jsxs)("span",{className:"pc-frames__tile-display",children:[":",a.display]}),a.role&&(0,e.jsx)("span",{className:"pc-frames__tile-role",children:a.role}),(0,e.jsx)("span",{className:"pc-frames__tile-age",children:U(c)})]})]})},r)})})]}):(0,e.jsx)("div",{className:"pc-frames__state",children:"Loading deployed frames…"}),k&&(0,e.jsxs)("div",{className:"pc-frames__panel",role:"region","aria-label":"Frame live view",children:[(0,e.jsxs)("div",{className:"pc-frames__panel-head",children:[(0,e.jsx)(D,{size:13,"aria-hidden":!0}),(0,e.jsxs)("span",{children:[k.slug," ",(0,e.jsxs)("code",{children:[":",k.display]}),M?.role?` — ${M.role}`:""]}),d&&(0,e.jsx)("span",{className:"pc-frames__mode","data-drive":g,children:g?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(O,{size:11,"aria-hidden":!0})," DRIVING"]}):(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(A,{size:11,"aria-hidden":!0})," read-only"]})}),!d&&M&&(0,e.jsx)("span",{className:"pc-frames__tile-age",children:U(L-M.capturedAtMs)}),(0,e.jsxs)("span",{className:"pc-frames__panel-actions",children:[(0,e.jsx)("button",{type:"button",className:"pc-frames__panel-btn","data-active":d,onClick:()=>{d&&R(null),F(d?null:!0)},children:d?"Back to stills":"Watch live"}),d&&(0,e.jsx)(P,{label:g?"Hand the mouse/keyboard back to the agent":"Take the mouse/keyboard — disruptive to a working agent; audited (D-002)",children:(0,e.jsx)("button",{type:"button",className:"pc-frames__panel-btn","data-danger":!g,"data-active":g,onClick:()=>{R(g?null:!0)},children:g?"Release control":"Take control"})})]}),(0,e.jsx)("button",{type:"button",className:"pc-frames__panel-close",onClick:()=>{W()},"aria-label":"Close live view",children:(0,e.jsx)(re,{size:14,"aria-hidden":!0})})]}),d?g||T!==null?(0,e.jsx)(le,{slug:k.slug,display:k.display,drive:g}):(0,e.jsx)(de,{slug:k.slug,display:k.display,onUnavailable:a=>I(a)}):M?(0,e.jsx)("img",{className:"pc-frames__panel-img",src:`data:image/jpeg;base64,${M.jpegBase64}`,alt:`${k.slug} display :${k.display} (enlarged)`}):(0,e.jsx)("div",{className:"pc-frames__panel-img pc-frames__panel-idle",children:"display is idle — no frame yet"}),(0,e.jsxs)("div",{className:"pc-frames__panel-foot",children:[(0,e.jsx)(ae,{size:11,"aria-hidden":!0}),d?g?"live VNC session — you are driving this display (audited)":T!==null?`live VNC session (read-only) — screen track unavailable: ${T}`:'holepunch screen track — read-only; "Take control" switches to VNC for input (audited)':'stills refresh every few seconds — "Watch live" opens the live view']})]}),(0,e.jsx)("style",{children:`
        .pc-frames { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; padding: 14px 16px 16px; position: relative; }
        .pc-frames__topbar {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
          color: var(--fg, #e7f7ff);
        }
        .pc-frames__topbar svg { color: var(--accent, #38bdf8); }
        .pc-frames__title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
        .pc-frames__sub { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__spacer { flex: 1; }
        .pc-frames__state {
          display: flex; align-items: center; gap: 7px;
          font-size: 12px; color: var(--fg-mute, #7f9bb4); padding: 10px 2px;
        }
        .pc-frames__state[data-error='true'] { color: #fca5a5; }
        .pc-frames__state code { font-size: 11px; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__statusrow { display: flex; flex-wrap: wrap; gap: 6px; }
        .pc-frames__chip {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 600; color: var(--fg-dim, #b9d4e8);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 999px; padding: 3px 9px;
          background: rgba(255, 255, 255, 0.03);
        }
        .pc-frames__chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #475569; }
        .pc-frames__chip-dot[data-state='polling'] { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
        .pc-frames__chip-dot[data-state='error'] { background: #f87171; }
        .pc-frames__chip-meta { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
          overflow-y: auto;
          min-height: 0;
        }
        .pc-frames__tile {
          position: relative;
          aspect-ratio: 16 / 9;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 12px;
          overflow: hidden;
          background: var(--bg-2, rgba(255, 255, 255, 0.035));
          cursor: pointer;
          padding: 0;
          transition: border-color 150ms, box-shadow 150ms, opacity 150ms;
        }
        .pc-frames__tile:hover { border-color: var(--accent, #38bdf8); box-shadow: none; }
        .pc-frames__tile[data-selected='true'] { border-color: var(--accent, #38bdf8); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent, #38bdf8), transparent 60%); }
        .pc-frames__tile[data-stale='true'] { opacity: 0.55; }
        .pc-frames__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .pc-frames__local-link { font-size: 12px; color: var(--accent, #38bdf8); text-decoration: none; white-space: nowrap; }
        .pc-frames__local-link:hover, .pc-frames__local-link:focus-visible { text-decoration: underline; }
        .pc-frames__tile-meta {
          position: absolute; left: 0; right: 0; bottom: 0;
          display: flex; align-items: center; gap: 6px;
          padding: 14px 10px 7px;
          background: linear-gradient(to top, rgba(7, 16, 29, 0.92), transparent);
          font-size: 11px; color: var(--fg, #e7f7ff); text-align: left;
        }
        .pc-frames__tile-slug { font-weight: 700; }
        .pc-frames__tile-display { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__tile-role {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%); border-radius: 5px; padding: 0 5px;
        }
        .pc-frames__tile-age { margin-left: auto; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-frames__panel {
          position: absolute; inset: 56px 16px 16px;
          display: flex; flex-direction: column;
          border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 14px;
          background: rgba(7, 16, 29, 0.97);
          box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
          z-index: 5;
          overflow: hidden;
        }
        .pc-frames__panel-head {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 12px;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
        .pc-frames__panel-head svg { color: var(--accent, #38bdf8); }
        .pc-frames__panel-head code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__chip-watch {
          display: inline-flex; align-items: center; gap: 3px;
          font-size: 9.5px; font-weight: 700;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 999px; padding: 0 5px;
        }
        .pc-frames__chip-watch[data-drive='true'] { color: #f87171; border-color: rgba(248, 113, 113, 0.5); }
        .pc-frames__mode {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 9.5px; font-weight: 800; letter-spacing: 0;
          color: var(--accent, #38bdf8); border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 60%);
          border-radius: 5px; padding: 1px 6px;
        }
        .pc-frames__mode[data-drive='true'] {
          color: #fca5a5; border-color: rgba(248, 113, 113, 0.6);
          background: rgba(239, 68, 68, 0.14);
        }
        .pc-frames__panel-actions { margin-left: auto; display: inline-flex; gap: 6px; }
        .pc-frames__panel-btn {
          font-size: 10.5px; font-weight: 700;
          color: var(--fg-dim, #b9d4e8);
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.25));
          border-radius: 6px; padding: 3px 9px; cursor: pointer;
        }
        .pc-frames__panel-btn:hover { color: var(--fg, #e7f7ff); border-color: var(--accent, #38bdf8); }
        .pc-frames__panel-btn[data-active='true'] { color: var(--accent, #38bdf8); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 50%); }
        .pc-frames__panel-btn[data-danger='true']:hover { color: #fca5a5; border-color: rgba(248, 113, 113, 0.6); }
        .pc-frames__panel-idle { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__panel-close { background: transparent; border: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
        .pc-frames__panel-close:hover { color: var(--fg, #e7f7ff); }
        .pc-frames__panel-img { flex: 1; min-height: 0; object-fit: contain; background: #000; }
        .pc-frames__panel-foot {
          display: flex; align-items: center; gap: 6px;
          padding: 7px 12px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4);
          border-top: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
      `})]})}function U(p){if(p<0)return"now";const s=Math.round(p/1e3);return s<60?`${s}s ago`:`${Math.floor(s/60)}m ago`}export{B as LOCAL_DESKTOPS_HREF,fe as STALE_AFTER_MS,Me as default,U as formatAge};
