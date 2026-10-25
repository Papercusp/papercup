const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/dist-558d3705.css","assets/dist-73a03fec.js","assets/chunk-a1a4177d.js"])))=>i.map(i=>d[i]);
import{o as V}from"./chunk-a1a4177d.js";import{t as X}from"./react-ea1d8b8b.js";import{n as J,t as C}from"./preload-helper-9c81c42c.js";import{t as Y}from"./jsx-runtime-660d4162.js";var i=V(X());function Z(){if(typeof window>"u")return;const t=window;if(typeof t.__papercuspOriginalReload=="function")try{t.__papercuspOriginalReload();return}catch{}try{const n=new URL(window.location.href);n.searchParams.set("_r",String(Date.now())),window.location.href=n.toString();return}catch{}window.location.reload()}var G="language-plantuml-neutralized";function D(t){return t.replace(/language-plantuml(?![\w-])/g,G)}var o=Y();J();function B({style:t,className:n,raw:r}){const e=typeof r=="string"&&r.trim().length>0;return(0,o.jsxs)("div",{className:n,style:{display:"flex",flexDirection:"column",minHeight:120,fontSize:13,color:"var(--fg-mute, #7f9bb4)",...t},children:[(0,o.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",gap:12,flexWrap:"wrap",padding:e?"8px 12px":16,textAlign:"center",borderBottom:e?"1px solid var(--border, rgba(125,211,252,0.18))":void 0},children:[(0,o.jsxs)("span",{children:["Couldn’t load the markdown renderer",e?" — showing raw text. ":". ",(0,o.jsx)("span",{style:{fontSize:12},children:"The app was likely updated underneath this page."})]}),(0,o.jsx)("button",{type:"button",onClick:()=>Z(),style:{padding:"4px 14px",fontSize:12,fontWeight:600,color:"#06121b",background:"var(--accent, #57d7ff)",border:0,borderRadius:6,cursor:"pointer",flexShrink:0},children:"Reload"})]}),e&&(0,o.jsx)("pre",{style:{flex:1,minHeight:0,margin:0,padding:16,overflow:"auto",whiteSpace:"pre-wrap",wordBreak:"break-word",fontSize:13,lineHeight:1.6,color:"var(--fg, #e6e6e6)",background:"var(--bg-1, #19232a)",fontFamily:"ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"},children:r})]})}var $="/vditor";function Q(t){const n=t.trim(),r=n.match(/^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i)?.[1];if(r){const a=r.length===3?r.split("").map(s=>`${s}${s}`).join(""):r;return[Number.parseInt(a.slice(0,2),16),Number.parseInt(a.slice(2,4),16),Number.parseInt(a.slice(4,6),16)]}const e=n.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);return e?[Number(e[1]),Number(e[2]),Number(e[3])]:null}function F(t=typeof document>"u"?null:document.documentElement){if(!t||typeof window>"u")return"dark";if(t.dataset.theme==="portal-light")return"light";if(t.dataset.theme==="portal-dark")return"dark";const n=window.getComputedStyle(t),r=Q(n.getPropertyValue("--bg"));if(r){const[a,s,l]=r;return(a*299+s*587+l*114)/1e3>=160?"light":"dark"}const e=n.colorScheme;return e.includes("light")&&!e.includes("dark")?"light":"dark"}function M(){return typeof document>"u"||typeof window>"u"?null:JSON.stringify([document.documentElement.getAttribute("data-theme"),document.documentElement.getAttribute("style"),window.matchMedia?.("(prefers-color-scheme: dark)").matches??null])}function K(){const t=(0,i.useRef)(null),[n,r]=(0,i.useState)(()=>(t.current=M(),F()));return(0,i.useEffect)(()=>{if(typeof window>"u"||typeof document>"u")return;const e=()=>{t.current=M(),r(F())};window.addEventListener("papercusp:theme-changed",e),window.addEventListener("storage",e);const a=typeof MutationObserver>"u"?null:new MutationObserver(e);a?.observe(document.documentElement,{attributes:!0,attributeFilter:["data-theme","style"]});const s=typeof window.matchMedia=="function"?window.matchMedia("(prefers-color-scheme: dark)"):null;return s?.addEventListener?.("change",e),s?.addListener?.(e),t.current!==M()&&e(),()=>{window.removeEventListener("papercusp:theme-changed",e),window.removeEventListener("storage",e),a?.disconnect(),s?.removeEventListener?.("change",e),s?.removeListener?.(e)}},[]),n}var N=null;function q(){return N||(N=C(()=>Promise.resolve({}),__vite__mapDeps([0]))),N}var L=null;function de(){return L||(L=(async()=>{try{await q();const t=(await C(async()=>{const{default:r}=await import("./dist-73a03fec.js").then(e=>V(e.default));return{default:r}},__vite__mapDeps([1,2]))).default,n=document.createElement("div");return await t.preview(n,"warm",{cdn:$,transform:D,math:{engine:"KaTeX"},mode:"dark",lang:"en_US"}),!0}catch{return L=null,!1}})(),L)}function ee(t){return(t??"").replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,(n,r,e)=>{const a=r.trim();let s=a,l=null;const f=a.indexOf("/");f>0&&(l=a.slice(0,f),s=a.slice(f+1));const v=(e??a).trim(),g=new URLSearchParams({target:s});return l&&g.set("harness",l),`[${v}](/wiki?${g.toString()})`})}function ce({value:t,outline:n=!1,className:r,style:e,renderers:a,onParsed:s}){const l=(0,i.useRef)(null),f=(0,i.useRef)(null),v=(0,i.useRef)(a);v.current=a;const g=(0,i.useRef)(s);g.current=s;const[O,S]=(0,i.useState)(!1),m=K();if((0,i.useEffect)(()=>{if(!l.current)return;let d=!1,w;return S(!1),(async()=>{await q();const b=(await C(async()=>{const{default:u}=await import("./dist-73a03fec.js").then(_=>V(_.default));return{default:u}},__vite__mapDeps([1,2]))).default;if(d||!l.current)return;const T={cdn:$,transform:D,mode:m,theme:{current:m},math:{engine:"KaTeX"},anchor:1,lang:"en_US"};if(v.current&&(T.renderers=v.current),await b.preview(l.current,ee(t??""),T),!(d||!l.current)){try{g.current?.(l.current)}catch{}if(n&&f.current&&l.current){const u=f.current,_=l.current;u.innerHTML="",b.outlineRender(_,u);const A=Array.from(u.querySelectorAll("a"));for(const p of A){const c=`${W(p)??""} ${p.textContent??""}`;p.dataset.planOutlineKind=/\bp-\d{3,}\b/i.test(c)?"item":/\bd-\d{3,}\b/i.test(c)?"decision":"section",p.tabIndex=0}const P=p=>{for(const c of A)c===p?c.setAttribute("aria-current","location"):c.removeAttribute("aria-current")},x=p=>{const c=p.target instanceof Element?p.target.closest("a"):null;if(!c||!u.contains(c))return;const y=W(c);if(!y)return;const R=Array.from(_.querySelectorAll("[id]")).find(h=>h.id===y);R&&(p.preventDefault(),p.stopPropagation(),P(c),R.scrollIntoView({block:"start",behavior:"smooth"}))};u.addEventListener("click",x,!0),w=()=>u.removeEventListener("click",x,!0)}}})().catch(b=>{d||(S(!0),console.error("[MarkdownPreview] vditor failed to load:",b))}),()=>{d=!0,w?.()}},[t,n,m]),O)return(0,o.jsx)(B,{className:r,style:e,raw:t});if(n){const d=n==="right"?"right":"left",w=(0,o.jsxs)("nav",{"aria-label":"Plan outline",className:`pc-md-outline-shell pc-md-outline-shell--${d}`,children:[(0,o.jsxs)("div",{className:"pc-md-outline__header",children:[(0,o.jsx)("span",{children:"Plan outline"}),(0,o.jsx)("span",{className:"pc-md-outline__legend","aria-hidden":"true",children:"P items · D decisions"})]}),(0,o.jsx)("div",{ref:f,className:"pc-md-outline"})]});return(0,o.jsxs)("div",{className:["pc-md-preview-layout",`pc-md-preview-layout--outline-${d}`,r].filter(Boolean).join(" "),style:e,children:[d==="left"&&w,(0,o.jsx)("div",{ref:l,className:"vditor-reset pc-md-preview"}),d==="right"&&w,(0,o.jsx)("style",{children:`
          ${te}
          ${H}
        `})]})}return(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("div",{ref:l,className:`vditor-reset pc-md-preview ${r??""}`,style:{background:"var(--bg-1, #19232a)",color:"var(--fg, #e6e6e6)",...e}}),(0,o.jsx)("style",{children:H})]})}function W(t){const n=t.dataset.targetId?.trim();if(n)return n;const r=t.getAttribute("href")??"";if(!r.startsWith("#")||r.length===1)return null;try{return decodeURIComponent(r.slice(1))}catch{return r.slice(1)}}var te=`
  .pc-md-preview-layout {
    container-type: inline-size;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    gap: clamp(10px, 2vw, 18px);
    background: var(--bg-1, #19232a);
  }
  .pc-md-preview-layout > .pc-md-preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    color: var(--fg, #e6e6e6);
  }
  .pc-md-outline-shell {
    position: sticky;
    top: 0;
    align-self: flex-start;
    display: flex;
    flex: 0 0 clamp(190px, 22cqi, 248px);
    flex-direction: column;
    width: clamp(190px, 22cqi, 248px);
    max-height: min(72vh, calc(100vh - 100px));
    overflow: hidden;
    color: var(--fg-mute, #7f9bb4);
    background: color-mix(in srgb, var(--bg-2, #111b2d), transparent 8%);
    border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
    border-radius: 10px;
  }
  .pc-md-outline__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px 8px;
    color: var(--fg, #e7f7ff);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  }
  .pc-md-outline__legend {
    color: var(--fg-dim, #9db5c8);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    white-space: nowrap;
  }
  .pc-md-outline.vditor-outline {
    display: block;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
  }
  .pc-md-outline ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pc-md-outline ul ul {
    margin-inline-start: 7px;
    padding-inline-start: 8px;
    border-inline-start: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  }
  .pc-md-outline li {
    margin: 2px 0;
  }
  .pc-md-outline a {
    --pc-outline-kind: transparent;
    position: relative;
    display: block;
    padding: 4px 7px 4px 10px;
    color: var(--fg-mute, #7f9bb4);
    font-size: 12px;
    line-height: 1.4;
    text-decoration: none;
    overflow-wrap: anywhere;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .pc-md-outline a::before {
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 3px;
    width: 2px;
    content: '';
    background: var(--pc-outline-kind);
    border-radius: 999px;
  }
  .pc-md-outline a[data-plan-outline-kind='section'] {
    color: var(--fg-dim, #b9d4e8);
    font-weight: 650;
  }
  .pc-md-outline a[data-plan-outline-kind='item'] {
    --pc-outline-kind: var(--accent, #57d7ff);
  }
  .pc-md-outline a[data-plan-outline-kind='decision'] {
    --pc-outline-kind: var(--warn, #fb923c);
  }
  .pc-md-outline a:hover {
    color: var(--fg, #e7f7ff);
    background: var(--bg-3, rgba(255, 255, 255, 0.075));
  }
  .pc-md-outline a:focus-visible {
    color: var(--fg, #e7f7ff);
    background: color-mix(in srgb, var(--accent, #57d7ff) 11%, transparent);
    border-color: color-mix(in srgb, var(--accent, #57d7ff) 58%, transparent);
    outline: 2px solid color-mix(in srgb, var(--accent, #57d7ff) 56%, transparent);
    outline-offset: 1px;
  }
  .pc-md-outline a[aria-current='location'] {
    color: var(--fg, #e7f7ff);
    font-weight: 650;
    background: color-mix(in srgb, var(--accent, #57d7ff) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent, #57d7ff) 36%, transparent);
  }
  .pc-md-preview-layout .pc-md-preview,
  .pc-md-preview-layout .pc-md-preview pre,
  .pc-md-preview-layout .pc-md-preview code {
    background-color: var(--bg-1, #0b1220) !important;
  }
  @container (max-width: 680px) {
    .pc-md-preview-layout {
      flex-direction: column;
    }
    .pc-md-outline-shell {
      position: relative;
      order: -1;
      width: 100%;
      max-height: none;
      flex-basis: auto;
    }
    .pc-md-outline.vditor-outline {
      max-height: 190px;
    }
  }
`,H=`
  .pc-md-preview :is(pre, pre code) {
    background: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%) !important;
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview pre {
    border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32)) !important;
    border-radius: 12px !important;
  }
  .pc-md-preview :is(code.language-yaml, code.language-yml, code.language-frontmatter, pre code:first-child) {
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview :is(.hljs-attr, .hljs-attribute, .hljs-keyword, .hljs-meta) {
    color: var(--accent-strong, #7dd3fc) !important;
  }
  .pc-md-preview :is(.hljs-string, .hljs-literal, .hljs-number) {
    color: var(--fg-dim, #b9d4e8) !important;
  }
`,re=["headings","bold","italic","strike","|","list","ordered-list","check","quote","|","code","inline-code","link","table","|","edit-mode","preview","outline","export"];function le({value:t,onChange:n,mode:r="ir",readOnly:e=!1,height:a="100%",minHeight:s=200,toolbar:l=re,outline:f=!1,className:v,style:g,placeholder:O,onInstance:S}){const m=(0,i.useRef)(null),d=(0,i.useRef)(null),w=(0,i.useRef)(n);w.current=n;const b=(0,i.useRef)(S);b.current=S;const T=(0,i.useRef)(t),[u,_]=(0,i.useState)(!1),[A,P]=(0,i.useState)(!1),x=K(),p=(0,i.useRef)(x);return p.current=x,(0,i.useEffect)(()=>{let c=!1;return P(!1),(async()=>{await q();const y=(await C(async()=>{const{default:E}=await import("./dist-73a03fec.js").then(k=>V(k.default));return{default:E}},__vite__mapDeps([1,2]))).default;if(c||!m.current)return;const R=p.current,h=new y(m.current,{cdn:$,mode:r,theme:R==="dark"?"dark":"classic",lang:"en_US",cache:{enable:!1},undoDelay:0,minHeight:s,placeholder:O,toolbar:l,outline:f?{enable:!0,position:f}:{enable:!1,position:"left"},preview:{theme:{current:R},math:{engine:"KaTeX"},transform:D},input:E=>w.current?.(E),after:()=>{if(!c){if(d.current=h,h.setValue(T.current??""),e?h.disabled():h.enable(),f){const E=()=>{const k=m.current?.querySelector(".vditor-outline");k&&(k.style.display="block",!k.dataset.pcOutlineWired&&(k.dataset.pcOutlineWired="1",k.addEventListener("click",I=>{let j=I.target;for(;j&&j!==k;){const z=j.getAttribute?.("data-target-id");if(z){const U=m.current?.querySelector(`#${CSS.escape(z)}`);U&&(I.preventDefault(),I.stopPropagation(),U.scrollIntoView({block:"start",behavior:"smooth"}));return}j=j.parentElement}},!0)))};requestAnimationFrame(()=>requestAnimationFrame(E)),setTimeout(E,100),setTimeout(E,400)}_(!0);try{b.current?.(h)}catch{}}}})})().catch(y=>{c||(P(!0),console.error("[MarkdownEditor] vditor failed to load:",y))}),()=>{c=!0;try{b.current?.(null)}catch{}try{d.current?.destroy()}catch{}d.current=null,_(!1)}},[r,JSON.stringify(l)]),(0,i.useEffect)(()=>{if(!u||!d.current)return;const c=d.current;if(c.getValue()===t)return;const y=window.scrollX,R=window.scrollY,h=!!m.current?.contains(document.activeElement);c.setValue(t??""),h||requestAnimationFrame(()=>window.scrollTo(y,R))},[t,u]),(0,i.useEffect)(()=>{!u||!d.current||(e?d.current.disabled():d.current.enable())},[e,u]),(0,i.useEffect)(()=>{!u||!d.current||d.current.setTheme(x==="dark"?"dark":"classic",x)},[x,u]),A?(0,o.jsx)(B,{className:v,style:{height:a,...g},raw:t}):(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("style",{children:`
        /* Vditor mounts INTO the container element and adds .vditor class names
         * to it. To get internal scrolling instead of vertical-overflow, we
         * override Vditor's inline height with !important. The .vditor-ir
         * element is the scroll container — Vditor's outline click handler
         * does \`vditor.ir.element.scrollTop = …\`, so .vditor-ir MUST be the
         * overflow:auto layer (not its inner <pre>) for outline links to work. */
        /* Vditor owns its class-level palette, but the host owns the semantic
         * surface. Apply live tokens in both classic and dark modes so a
         * theme switch never reveals a stale hard-coded strip while scrolling. */
        .pc-md-editor-host.vditor {
          --panel-background-color: var(--bg-1) !important;
          --toolbar-background-color: var(--bg-1) !important;
          --textarea-background-color: var(--bg-1) !important;
          background-color: var(--bg-1) !important;
          color: var(--fg) !important;
        }
        .pc-md-editor-host.vditor .vditor-content,
        .pc-md-editor-host.vditor .vditor-ir,
        .pc-md-editor-host.vditor .vditor-wysiwyg,
        .pc-md-editor-host.vditor .vditor-sv,
        .pc-md-editor-host.vditor .vditor-reset,
        .pc-md-editor-host.vditor .vditor-outline,
        .pc-md-editor-host.vditor .vditor-toolbar {
          background-color: var(--bg-1) !important;
          color: var(--fg) !important;
        }
        .pc-md-editor-host.vditor { display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0; }
        .pc-md-editor-host.vditor > .vditor-toolbar { flex: 0 0 auto; }
        .pc-md-editor-host.vditor > .vditor-content { flex: 1 1 0 !important; min-height: 0 !important; display: flex !important; overflow: hidden !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-outline { flex: 0 0 auto; max-width: 240px; overflow: auto; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv { flex: 1 1 0 !important; min-height: 0 !important; overflow: auto !important; background-color: var(--bg-2) !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv > pre { overflow: visible !important; min-height: 100%; box-sizing: border-box; }
      `}),(0,o.jsx)("div",{ref:m,className:`pc-md-editor-host ${v??""}`,style:{height:a,width:"100%",minHeight:0,...g}})]})}export{Z as i,ce as n,de as r,le as t};
