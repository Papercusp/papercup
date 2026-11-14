(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchStudy = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const sessions = [
    { id: 'nav', title: 'Seamless session navigation', task: 'Native Workbench', provider: 'Codex', host: 'This desktop', state: 'open', age: 'Now', badge: 'Working', summary: 'A shared contract for switching, search and exact activation.', turns: [{ role: 'You', text: 'Make switching between different terminals as seamless as possible.' }, { role: 'Codex', text: 'Keep keyboard focus on the selected conversation. Preview first, then activate the exact existing terminal.' }], draft: 'Let’s also preserve the current draft when switching.' },
    { id: 'shell', title: 'GNOME shell integration', task: 'Native Workbench', provider: 'Claude', host: 'This desktop', state: 'open', age: '2 min', badge: 'Needs answer', summary: 'Resident entry, native surfaces and the existing terminal.', turns: [{ role: 'You', text: 'What should the extension own?' }, { role: 'Claude', text: 'Desktop entry and exact window activation. Shared session search stays in Workbench; keyboard focus must survive a result refresh.' }], draft: 'Keep the extension thin.', unread: true },
    { id: 'launch', title: 'Launch page finishing touches', task: 'Atlas launch', provider: 'Codex', host: 'This desktop', state: 'open', age: '8 min', badge: 'Ready', summary: 'Final copy and responsive checks before launch.', turns: [{ role: 'You', text: 'Keep the launch copy simple.' }, { role: 'Codex', text: 'The page is ready for your review. I retained the draft headline and the narrower layout.' }], draft: 'Try a shorter headline.' },
    { id: 'remote', title: 'Windows workspace adapter', task: 'Native Workbench', provider: 'Codex', host: 'Windows lab', state: 'remote', age: '12 min', badge: 'Working', summary: 'Window identity and saved remote session attachment.', turns: [{ role: 'You', text: 'Attach to the existing Windows session.' }, { role: 'Codex', text: 'The saved connection identifies the original terminal. Reattaching must not create another agent.' }], draft: '' },
    { id: 'stale', title: 'Release packaging check', task: 'Release', provider: 'Claude', host: 'Build host', state: 'stale', age: '32 min', badge: 'Unavailable', summary: 'The host is unavailable. Refresh its identity before activating.', turns: [{ role: 'Claude', text: 'Packaging notes retained. This host is currently unavailable.' }], draft: '' },
    { id: 'history', title: 'Window manager comparison', task: 'Native Workbench', provider: 'Codex', host: 'This desktop', state: 'ended', age: 'Yesterday', badge: 'Ended', summary: 'The completed comparison of GlazeWM and GNOME integration.', turns: [{ role: 'You', text: 'Compare the window manager alternatives.' }, { role: 'Codex', text: 'Use GlazeWM for Windows and macOS, and GNOME Shell extensions for Linux/GNOME. Resume this history explicitly.' }], draft: '' },
  ];
  function createState() {
    return { active: 'nav', selected: 'nav', origin: 'nav', view: 'a', scope: 'open', query: '', task: '', visible: true, mru: sessions.filter(s => s.state !== 'ended').map(s => s.id), drafts: Object.fromEntries(sessions.map(s => [s.id, s.draft])), sidebars: Object.fromEntries(sessions.map(s => [s.id, true])), resumed: [], message: '', report: false };
  }
  const get = id => sessions.find(s => s.id === id);
  function results(state) {
    const q = state.query.trim().toLocaleLowerCase();
    return sessions.filter(s => (state.scope === 'history' || s.state !== 'ended' || state.resumed.includes(s.id)) && (!state.task || s.task === state.task))
      .map(session => ({ session, matches: session.turns.filter(t => t.text.toLocaleLowerCase().includes(q)) }))
      .filter(({ session, matches }) => !q || [session.title, session.task, session.provider, session.host].some(v => v.toLocaleLowerCase().includes(q)) || matches.length)
      .sort((a, b) => {
        const rank = id => state.mru.includes(id) ? state.mru.indexOf(id) : 999;
        return rank(a.session.id) - rank(b.session.id);
      });
  }
  function reconcile(state) { const rows = results(state); if (!rows.some(r => r.session.id === state.selected)) state.selected = rows[0]?.session.id || null; return state; }
  function search(state, query) { state.query = query; state.message = ''; return reconcile(state); }
  function preview(state, id) { if (results(state).some(r => r.session.id === id)) state.selected = id; return state; }
  function step(state, delta) { const rows = results(state); if (!rows.length) return state; const i = rows.findIndex(r => r.session.id === state.selected); state.selected = rows[(Math.max(0, i) + delta + rows.length) % rows.length].session.id; return state; }
  function activate(state, resume = false) {
    const target = get(state.selected);
    if (!target || !results(state).some(r => r.session.id === target.id)) return { ok: false, error: 'Select a conversation first.' };
    if (target.state === 'stale') return { ok: false, error: 'Build host is unavailable. Your current conversation is unchanged.' };
    if (target.state === 'ended' && !state.resumed.includes(target.id) && !resume) return { ok: false, error: 'This conversation ended. Choose Resume explicitly.' };
    if (target.state === 'ended' && !state.resumed.includes(target.id)) state.resumed.push(target.id);
    state.active = target.id; state.mru = [target.id, ...state.mru.filter(id => id !== target.id)]; state.visible = false;
    state.message = target.state === 'remote' ? 'Reattached to the existing session on Windows lab.' : `Opened ${target.title}.`;
    return { ok: true, id: target.id, action: target.state === 'remote' ? 'reattach' : target.state === 'ended' ? 'resume' : 'focus' };
  }
  function summon(state) { state.origin = state.active; state.visible = true; state.query = ''; state.task = ''; state.selected = state.mru.find(id => id !== state.active) || state.active; return state; }
  function cancel(state) { state.visible = false; state.selected = state.origin; state.query = ''; state.message = 'Switcher dismissed. Original conversation preserved.'; return state; }
  return { sessions, createState, get, results, reconcile, search, preview, step, activate, summon, cancel };
});
