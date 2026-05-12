'use client';

import { OracleLogoMark } from './OracleLogoMark';

// OracleDock is lazy-loaded behind a `ready` gate in ChromeShell, so a click
// firing before its useEffect has attached the 'oracle:start-tutorial'
// listener gets dropped on the floor. Persist a one-shot intent flag in
// addition to dispatching the event; OracleDock consumes the flag on mount.
const TUTORIAL_INTENT_KEY = 'papercusp.tutorial.intent';

export default function TutorialButton() {
  const onClick = () => {
    try { localStorage.setItem(TUTORIAL_INTENT_KEY, '1'); } catch { /* quota / safari private */ }
    window.dispatchEvent(new CustomEvent('oracle:start-tutorial'));
  };
  return (
    <button
      type="button"
      className="oracle-link oracle-link--tutorial"
      style={{ background: 'transparent', border: 0, padding: '4px 8px', cursor: 'pointer', font: 'inherit' }}
      onClick={onClick}
      title="Walk me through the app"
    >
      <OracleLogoMark className="oracle-link-icon" />
      <span>Tutorial</span>
    </button>
  );
}
