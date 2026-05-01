'use client';

export default function TutorialButton() {
  return (
    <button
      type="button"
      className="oracle-link"
      style={{ background: 'transparent', border: 0, padding: '4px 8px', cursor: 'pointer', font: 'inherit' }}
      onClick={() => window.dispatchEvent(new CustomEvent('oracle:start-tutorial'))}
      title="Walk me through the app"
    >
      Tutorial
    </button>
  );
}
