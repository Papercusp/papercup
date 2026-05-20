import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: IndexPage,
});

function IndexPage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>operator-vite scaffold</h1>
      <p>
        Phase A scaffold — Vite + TanStack Router. The 62 operator pages
        translate in Phase B; providers wire in A3; the Hono host is Phase C.
      </p>
    </main>
  );
}
