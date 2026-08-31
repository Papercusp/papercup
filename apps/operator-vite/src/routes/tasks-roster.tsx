import { createFileRoute } from '@tanstack/react-router';
import TasksRosterPanel from '../components/adv/TasksRosterPanel';
import '../components/adv/adv-header-pills.css';

/**
 * /tasks-roster — chromeless iframe target for the hosted Portal's process pill.
 *
 * This is deliberately only composition. The inventory query, search, resource
 * totals, grouping, kill guard and full-manager link all remain owned by the
 * canonical TasksRosterPanel that the native operator pill renders.
 */
export const Route = createFileRoute('/tasks-roster')({
  component: TasksRosterEmbedRoute,
});

export function TasksRosterEmbedRoute() {
  return (
    <div className="pc-tasks-roster-embed" data-testid="tasks-roster-embed">
      <TasksRosterPanel active />
    </div>
  );
}
