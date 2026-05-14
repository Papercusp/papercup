import AdminShell from '../_components/AdminShell';
import TestingClient from './TestingClient';
import './testing.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Testing · Papercusp' };

export default function AdminTestingPage() {
  return (
    <AdminShell title="Testing">
      <TestingClient />
    </AdminShell>
  );
}
