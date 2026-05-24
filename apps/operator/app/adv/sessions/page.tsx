export const dynamic = 'force-dynamic';
export const metadata = { title: 'Advanced · Sessions · Papercusp' };

// Sessions surface — lists agent terminal sessions launched from
// the Plans tab. Wired in Batch C: new harness_shared.adv_sessions
// table, hooked into launchOmpAgent / launchNativeConsole, with
// focus (active windows) + omp --resume (inactive) actions.
export default function AdvSessionsPage() {
  return (
    <div style={{ padding: '32px 18px', color: 'rgba(220, 214, 248, 0.78)' }}>
      <h2 style={{ marginTop: 0, fontSize: 18, fontWeight: 700, color: '#f7f5ff' }}>
        Sessions
      </h2>
      <p style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 560 }}>
        Agent terminal sessions launched from the Plans tab will appear
        here, with controls to focus the live window or resume the
        session via <code>omp --resume</code>. Wiring up in the next
        batch — see plan plans-admin-ui-2026-05-20.
      </p>
    </div>
  );
}
