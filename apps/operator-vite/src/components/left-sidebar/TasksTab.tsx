import type { ReactElement } from 'react';
import TasksClient from '@/app/admin/tasks/TasksClient';

/**
 * Tasks — the left-rail face of the task manager
 * (task-manager-no-escape-2026-07-27, P-018 follow-up).
 *
 * Sits alongside `System` and `Spend` conceptually: System is *what we scheduled*,
 * Tasks is *what is actually executing*, Spend is *what it cost in dollars*. Tasks
 * is the resource counterpart to Spend — CPU-seconds and RSS per work-item.
 *
 * Thin reuse of the same self-fetching `TasksClient` the /admin/tasks page renders,
 * via the `@/app` alias, so there is ONE table implementation and the rail can
 * never drift from the admin page.
 *
 * `active` gates the mount: the client polls `/api/admin/tasks/inventory` every 5s
 * and, with `live=1`, that walks the cgroup tree. Mounting it on an inactive tab
 * would run a kernel scan every 5 seconds for a pane nobody is looking at.
 */
export default function TasksTab({ active }: { active: boolean }): ReactElement | null {
  if (!active) return null;
  return <TasksClient />;
}
