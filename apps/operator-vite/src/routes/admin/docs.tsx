import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';

/**
 * /admin/docs — engineering reference (Starlight at apps/operator-docs)
 * embedded inside the admin chrome. The Hono host serves these at
 * /internal/docs/* (see `apps/operator/bin/host-docs.ts`, loopback-gated)
 * — the browser-side iframe is loopback so the gate accepts. The
 * **public** docs site lives at /docs (apps/papercusp-docs) and is
 * still served, just not embedded in admin.
 */
export const Route = createFileRoute('/admin/docs')({
  component: AdminDocsPage,
});

function AdminDocsPage() {
  return (
    <AdminShell title="Docs">
      <iframe
        src="/internal/docs"
        title="Papercusp Engineering Docs"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          minHeight: 'calc(100vh - 56px - 78px)',
          border: 'none',
          background: 'transparent',
        }}
      />
    </AdminShell>
  );
}
