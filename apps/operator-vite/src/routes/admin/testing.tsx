import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import TestingClient from '../../components/admin/TestingClient';
import '@/app/admin/testing/testing.css';

/**
 * /admin/testing — testing/chaos console. Translated from
 * `apps/operator/app/admin/testing/page.tsx`. Uses the Vite-flavored
 * TestingClient (React.lazy in place of next/dynamic).
 */
export const Route = createFileRoute('/admin/testing')({
  component: AdminTestingPage,
});

function AdminTestingPage() {
  return (
    <AdminShell title="Testing">
      <TestingClient />
    </AdminShell>
  );
}
