(() => {
  'use strict';
  const M = window.WorkbenchStudy, state = M.createState(), desktop = document.querySelector('#desktop');
  let platform = 'linux';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const badge = s => `<span class="provider ${s.provider.toLowerCase()}">${s.provider === 'Codex' ? '✳' : '✦'}</span>`;
  function row({ session:s, matches }) { return `<button class="result ${state.selected === s.id ? 'selected' : ''}" data-session="${s.id}" aria-label="Preview ${esc(s.title)}" aria-pressed="${state.selected === s.id}">${badge(s)}<div class="result-body"><div class="result-title">${esc(s.title)}</div><div class="result-meta"><span class="dot ${s.badge === 'Needs answer' ? 'warn' : s.state === 'stale' || s.state === 'ended' ? 'off' : ''}"></span>${esc(s.task)} · ${esc(s.host)}</div>${state.query && matches.length ? `<p class="match-snippet">${esc(matches[0].text.slice(0,105))}…</p>` : ''}</div><span class="result-age">${s.age}</span></button>`; }
  function list() { const rows = M.results(state); return `<div class="result-list" aria-label="Conversation results">${rows.length ? rows.map(row).join('') : '<div class="empty">No matching conversations.<br>Try another phrase or include History.</div>'}</div>`; }
  function searchbar(extra='') { return `<div class="searchbar"><span class="search-icon" aria-hidden="true">⌕</span><input id="conversation-search" aria-label="Search conversations" placeholder="Search a conversation, or something said…" value="${esc(state.query)}" autocomplete="off">${extra}</div>`; }
  function scopes() { return `<div class="scopebar"><button data-scope="open" class="${state.scope==='open'?'active':''}" aria-pressed="${state.scope==='open'}">Open</button><button data-scope="history" class="${state.scope==='history'?'active':''}" aria-pressed="${state.scope==='history'}">Include history</button><span>${M.results(state).length} conversations</span></div>`; }
  function preview() {
    const s=M.get(state.selected); if(!s || !M.results(state).some(r=>r.session.id===s.id)) return '<aside class="preview-pane"><div class="empty">Choose a conversation to preview.</div></aside>';
    const match=(state.query && M.results(state).find(r=>r.session.id===s.id).matches[0]) || s.turns.at(-1);
    const ended=s.state==='ended'&&!state.resumed.includes(s.id);
    const label=ended?'Resume conversation':s.state==='remote'?'Reattach to session':s.state==='stale'?'Check connection':'Switch to conversation';
    return `<aside class="preview-pane" aria-label="Conversation preview"><div class="micro">${state.query?'Matching turn':'Conversation preview'} · ${s.provider}</div><h2>${esc(s.title)}</h2><div class="session-meta">${esc(s.task)} <span> / </span> ${esc(s.host)} · ${s.badge}</div><blockquote class="quote">${esc(match.text)}</blockquote><p class="preview-caption">${state.query?'Exact turn preview. Terminal history stays where you left it.':'Previewing keeps your current terminal and draft untouched.'}</p><div class="preview-actions"><button class="primary" data-activate ${ended?'data-resume="true"':''}>${label}<span>↵</span></button></div></aside>`;
  }
  function terminal() {
    const s=M.get(state.active);
    return `<section class="terminal" aria-label="Vendor terminal"><div class="workspace-head"><div class="term-top"><span>● ${s.provider.toLowerCase()}</span><span>${esc(s.host)}</span></div><button data-sidebar>${state.sidebars[s.id]?'Hide context':'Show context'}</button></div><div class="term-provider">${s.provider} / ${esc(s.title)}</div><div class="term-path">~/workspace/${s.task==='Atlas launch'?'atlas':'papercusp'} &nbsp; · &nbsp; existing session</div><div class="term-message"><div class="role">› you</div><p class="prompt">${esc(s.turns[0].text)}</p><div class="role">✳ ${s.provider.toLowerCase()}</div><p>${esc(s.turns.at(-1).text)}</p><p>The <button class="report-link" data-report>detailed navigation summary ↗</button> is ready to review.</p></div><label class="draft-label" for="terminal-draft">YOUR DRAFT · RETAINED IN THIS SESSION</label><textarea id="terminal-draft" aria-label="Terminal draft" spellcheck="false">${esc(state.drafts[s.id])}</textarea><div class="term-footer"><span>${s.provider} · connected</span><span>draft saved locally in this study</span></div></section>`;
  }
  function titlebar(label){return `<div class="titlebar"><span class="window-dots"><i></i><i></i><i></i></span><span>${label}</span><span class="right">${platform==='mac'?'⌘':platform==='windows'?'⊞':'◇'} &nbsp; Papercup</span></div>`;}
  function context(){ const s=M.get(state.active); return state.sidebars[s.id]?`<aside class="context"><div class="micro">YOUR CONTEXT</div><h3>${esc(s.task)}</h3><p>Keep the work together.<br>Keep the terminal yours.</p><span class="tag">In progress</span><hr><div class="micro">RELATED</div><p>Navigation contract<br>Desktop adapters<br>Independent acceptance</p><button data-report>Open navigation summary ↗</button><hr><div class="micro">NEXT</div><p>Review the interaction, then verify the exact installed experience.</p></aside>`:'';}
  function quick(){return `<div class="app-window underlay">${titlebar('Native Workbench · '+M.get(state.active).title)}${terminal()}</div>${state.visible?`<div class="scrim"></div><section class="switcher" aria-label="Quick Switch">${searchbar('<span class="key">esc</span>')}${scopes()}<div class="switch-content">${list()}${preview()}</div><div class="switch-footer"><span><b>↑ ↓</b> preview &nbsp; <b>↵</b> switch &nbsp; <b>esc</b> cancel</span><span>Current: ${esc(M.get(state.active).title)}</span></div></section>`:'<button class="reopen" data-summon>⌕ Switch conversation <span class="key">Ctrl K</span></button>'}`;}
  function rail(){return `<div class="app-window">${titlebar('Native Workbench')}<div class="rail-body"><aside class="rail">${searchbar()}${scopes()}${list()}<div class="rail-bottom"><button data-activate>Open selected ↵</button></div></aside>${terminal()}${context()}</div></div>`;}
  function spaces(){ const groups=['Native Workbench','Atlas launch','Release'];return `<div class="app-window task-window">${titlebar('Task Spaces')}<div class="spaces-head"><div><h2>Your work, in place.</h2><p>One space for each thread of work.</p></div><button data-summon>Switch conversation ↗</button></div><div class="spaces-search">${searchbar()}</div>${state.query?`<div class="space-search-results">${list()}${preview()}</div>`:`<div class="space-grid">${groups.map((task,i)=>{const ss=M.sessions.filter(s=>s.task===task&&s.state!=='ended');return `<article class="space-card ${i===0?'current':''}"><div class="micro">${i===0?'CURRENT SPACE':i===1?'READY FOR REVIEW':'AWAITING CONNECTION'}</div><h3>${task}</h3><p class="description">${['Native desktop, one shared conversation layer.','The last mile before sharing it with the world.','Packaging and delivery, together.'][i]}</p><button class="mini-terminal" data-open="${ss[0].id}"><b>● ${ss[0].provider} / ${esc(ss[0].title)}</b>› ${esc(ss[0].turns[0].text.slice(0,72))}<br><span>▌</span></button>${i<2?`<div class="mini-apps"><div class="mini-app">▤ ${i===0?'Navigation spec':'Launch copy'}</div><div class="mini-app">▧ ${i===0?'Browser preview':'Atlas preview'}</div></div>`:''}${ss.slice(1).map(s=>row({session:s,matches:[]})).join('')}<div class="space-action"><span>${ss.length} conversation${ss.length===1?'':'s'}${i<2?' · 2 linked windows':''}</span><button data-task="${task}">Explore →</button></div></article>`;}).join('')}</div>`}</div>`;}
  function report(){return `<section class="report-reader" role="dialog" aria-modal="true" aria-label="Desktop report reader">${titlebar('Reports / Native Workbench')}<div class="report-content"><div class="micro">REPORT · SAMPLE PREVIEW</div><h2>Native Workbench<br>navigation summary</h2><p>Opened the exact report from a conversation link, keeping your workspace and terminal in place.</p><p><code>/reports?sel=sample-navigation-report</code></p><p>Shared session identity, open-conversation search and transactional activation connect GlazeWM on Windows/macOS with GNOME Shell integration on Linux.</p><ul><li>Preview before switching; Escape restores context.</li><li>Keep the vendor CLI, draft and layout intact.</li><li>Use one object link from terminal to desktop.</li></ul><p class="note">This reader demonstrates the handoff. It contains sample data and does not open a live report or control your desktop.</p><button class="primary" data-close-report>Return to conversation</button></div></section>`;}
  function render(focus=false){
    const old=document.activeElement, caret=old?.id==='conversation-search'?old.selectionStart:null;
    document.querySelectorAll('button[data-view]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.view===state.view));
    document.querySelector('#direction-caption').textContent={a:'A compact switcher that gets out of your way.',b:'A steady home for conversations beside the real terminal.',c:'A view of the whole task, with every conversation in place.'}[state.view];
    desktop.dataset.view=state.view;
    desktop.innerHTML=`<div class="osbar"><strong>${platform==='mac'?'◉ Finder':platform==='windows'?'⊞ Workspaces':'Activities'} &nbsp; / &nbsp; Papercup</strong><span>Thu 12 Nov &nbsp; 15:04</span><span>⌁ &nbsp; ◖ &nbsp; 100%</span></div><div class="desktop-bg"></div><span class="desktop-caption">A LITTLE MORE ROOM TO THINK.</span>${state.view==='a'?quick():state.view==='b'?rail():spaces()}${state.message?`<div class="toast" role="status">${esc(state.message)}</div>`:''}${state.report?report():''}`;
    if(focus||caret!==null){const input=document.querySelector('#conversation-search');input?.focus();if(input&&caret!==null)input.setSelectionRange(caret,caret);}
    if(state.report)document.querySelector('[data-close-report]')?.focus();
    document.querySelector('#announce').textContent=state.message;
  }
  function commit(resume=false){const r=M.activate(state,resume);if(!r.ok)state.message=r.error;render();}
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.view){state.view=b.dataset.view;state.visible=true;state.origin=state.active;state.query='';state.task='';M.reconcile(state);render(true);}
    else if(b.dataset.scope){state.scope=b.dataset.scope;M.reconcile(state);render(true);}
    else if(b.dataset.session){M.preview(state,b.dataset.session);render();}
    else if(b.hasAttribute('data-activate'))commit(b.dataset.resume==='true');
    else if(b.hasAttribute('data-summon')){state.view='a';M.summon(state);render(true);}
    else if(b.dataset.open){state.selected=b.dataset.open;const r=M.activate(state);if(r.ok)state.view='b';else state.message=r.error;render();}
    else if(b.dataset.task){state.task=b.dataset.task;state.view='b';state.visible=true;M.reconcile(state);render(true);}
    else if(b.hasAttribute('data-sidebar')){state.sidebars[state.active]=!state.sidebars[state.active];render();}
    else if(b.hasAttribute('data-report')){state.report=true;render();}
    else if(b.hasAttribute('data-close-report')){state.report=false;render();document.querySelector('[data-report]')?.focus();}
  });
  document.addEventListener('input',e=>{if(e.target.id==='conversation-search'){M.search(state,e.target.value);render();}if(e.target.id==='terminal-draft')state.drafts[state.active]=e.target.value;});
  document.querySelector('#platform').addEventListener('change',e=>{platform=e.target.value;render();});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();state.view='a';M.summon(state);render(true);return;}
    if(state.report){if(e.key==='Escape'){state.report=false;render();}if(e.key==='Tab'){e.preventDefault();document.querySelector('[data-close-report]')?.focus();}return;}
    if(e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
    if(e.key==='Escape'){e.preventDefault();M.cancel(state);render();return;}
    if(e.target.id==='conversation-search'&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();M.step(state,e.key==='ArrowDown'?1:-1);render(true);}
    if(e.target.id==='conversation-search'&&e.key==='Enter'){e.preventDefault();commit(false);}
  });
  window.__navigationStudy={state,set(view,query=''){state.view=view;state.visible=true;state.report=false;state.message='';state.task='';state.scope='open';M.search(state,query);render();},render};
  render();
})();
