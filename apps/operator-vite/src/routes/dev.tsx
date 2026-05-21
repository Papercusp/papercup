import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/app/dev/dev.css';

/**
 * /dev layout — translated from `apps/operator/app/dev/layout.tsx`.
 * The original just imported `dev.css` for side-effect and rendered
 * children. Same here with TSR `<Outlet/>`.
 */
export const Route = createFileRoute('/dev')({
  component: DevLayout,
});

function DevLayout() {
  return <Outlet />;
}
