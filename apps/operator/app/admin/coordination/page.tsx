import AdminShell from '../_components/AdminShell';
import CoordinationClient from './CoordinationClient';

/**
 * /admin Coordination tab (integration-adoption-2026-06-03, Capstone P2) —
 * operator-level, cross-harness views over the coordination substrate: the
 * engineer-issue surface (the audit's missing cross-harness issues view), the
 * topic taxonomy + a topic's cross-object feed, and conversations (su-9fd2d's).
 * Loopback-only like the rest of /admin; not flag-gated (URL-reachable only).
 */
export default function AdminCoordinationPage() {
  return (
    <AdminShell title="Coordination">
      <CoordinationClient />
    </AdminShell>
  );
}
