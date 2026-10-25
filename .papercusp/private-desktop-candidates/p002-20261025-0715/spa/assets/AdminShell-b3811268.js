import{t as c}from"./jsx-runtime-660d4162.js";import{t as m}from"./link-c0cbfadb.js";import{t as p}from"./useRouterState-66b4d834.js";import{s as l}from"./client-975cebd8.js";import{t as h}from"./flag-hooks-862be484.js";import{n as b}from"./useLexicon-e47d5e4a.js";import{i as g,n as f,r as x}from"./dist-e7778137.js";var a=c(),_=[{href:"/admin/run",label:"Run"},{href:"/admin/features",label:"Features"},{href:"/admin/admission",label:"Admission"},{href:"/admin/triggers",label:"Triggers",flag:l.TRIGGERS_ADMIN},{href:"/admin/recipes",label:"Recipes"},{href:"/admin/git",label:"Git"},{href:"/admin/dogfood-substrate",label:"Substrate"},{href:"/admin/dbos",label:"DBOS"},{href:"/admin/schedules",label:"Schedules"},{href:"/admin/tasks",label:"Tasks"},{href:"/admin/work-scope",label:"Work scope"},{href:"/admin/governance-policy",label:"Governance policy"},{href:"/admin/cupboard-moderation",label:"Cupboard",term:"cupboard"}];function S({title:s="Admin",children:n}){const o=b(),t=h(l.TRIGGERS_ADMIN),r=_.filter(e=>e.flag!==l.TRIGGERS_ADMIN||t),i=p({select:e=>e.location.pathname})||"/admin/run",d=r.find(e=>i===e.href||i.startsWith(`${e.href}/`))??r[0];return(0,a.jsxs)("div",{className:"pc-adminshell",children:[(0,a.jsxs)("header",{className:"pc-adminshell__header",children:[(0,a.jsxs)("div",{className:"pc-adminshell__copy",children:[(0,a.jsx)("span",{className:"pc-adminshell__kicker",children:"Admin console"}),(0,a.jsx)("h1",{children:s})]}),(0,a.jsx)(x,{value:d.href,className:"pc-adminshell__tabs",children:(0,a.jsx)(f,{className:"pc-adminshell__tablist","aria-label":"Admin sections",children:r.map(e=>(0,a.jsx)(g,{value:e.href,asChild:!0,className:"pc-adminshell__tab",children:(0,a.jsx)(m,{to:e.href,children:e.term?o(e.term):e.label})},e.href))})}),(0,a.jsx)("span",{className:"pc-adminshell__spacer"}),(0,a.jsx)("span",{className:"pc-adminshell__host",children:"localhost · :3055"})]}),(0,a.jsx)("div",{className:"pc-adminshell__body",children:n}),(0,a.jsx)("style",{children:`
        .pc-adminshell {
          display: flex;
          flex-direction: column;
          min-height: calc(100vh - 56px);
          background:
            radial-gradient(circle at top left, color-mix(in srgb, var(--accent), transparent 94%), transparent 28%),
            linear-gradient(180deg, rgba(5, 12, 22, 0.99), rgba(4, 10, 18, 1));
        }
        .pc-adminshell__header {
          display: flex;
          align-items: flex-end;
          gap: 16px;
          padding: 14px 18px 12px;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.14));
          background:
            linear-gradient(180deg, rgba(7, 16, 29, 0.98), rgba(6, 13, 24, 0.98));
          box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.02);
        }
        .pc-adminshell__copy {
          display: grid;
          gap: 4px;
          min-width: 0;
        }
        .pc-adminshell__kicker {
          color: var(--fg-mute);
          font-size: 10px;
          font-weight: 760;
          letter-spacing: 0;
          line-height: 1;
          text-transform: uppercase;
        }
        .pc-adminshell__header h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 760;
          line-height: 1;
          letter-spacing: 0;
          color: var(--fg);
        }
        .pc-adminshell__tabs {
          align-self: stretch;
          display: flex;
          align-items: flex-end;
        }
        .pc-adminshell__tablist {
          display: inline-flex;
          align-items: flex-end;
          gap: 6px;
          padding: 0 0 1px;
        }
        .pc-adminshell__tab {
          display: inline-flex;
          align-items: center;
          min-height: 34px;
          padding: 0 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.14));
          border-bottom-color: color-mix(in oklab, var(--border, rgba(125, 211, 252, 0.14)), transparent 45%);
          border-radius: 10px 10px 0 0;
          background: rgba(255, 255, 255, 0.02);
          color: rgba(214, 236, 248, 0.72);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0;
          text-decoration: none !important;
          transition: background-color 120ms, border-color 120ms, color 120ms;
        }
        .pc-adminshell__tab:hover {
          color: #eff8ff;
          background: rgba(12, 24, 38, 0.96);
          border-color: var(--border-strong, rgba(125, 211, 252, 0.28));
          text-decoration: none !important;
        }
        .pc-adminshell__tab[aria-selected="true"] {
          color: #f7fdff;
          background:
            linear-gradient(180deg, rgba(17, 34, 53, 0.98), rgba(10, 20, 33, 0.99));
          border-color: color-mix(in srgb, var(--accent), transparent 62%);
          border-bottom-color: rgba(7, 16, 29, 0.98);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
        }
        .pc-adminshell__tab:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--accent), transparent 42%);
          outline-offset: 2px;
        }
        .pc-adminshell__spacer { flex: 1; }
        .pc-adminshell__host {
          align-self: center;
          padding: 5px 10px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.025);
          color: var(--fg-mute);
          font-size: 11px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .pc-adminshell__body {
          flex: 1;
          min-height: 0;
          overflow: auto;
        }
      `})]})}export{S as t};
