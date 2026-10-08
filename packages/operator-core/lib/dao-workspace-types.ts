/** Public wire contract; importing it never pulls server-store types into the UI. */
export type DaoRead<T> = { status: 'ready'; value: T } | { status: 'error'; message: string };
export interface DaoWorkspaceView {
  directoryId: string;
  localHomeSlug: string | null;
  status: 'connected' | 'not-joined';
  members?: DaoRead<Array<{ id: number; username: string; displayName: string | null; bindingStatus: string; devices: number }>>;
  policy?: DaoRead<{ version: number; membership: string | null; admission: unknown; delegations: unknown }>;
  governance?: DaoRead<{ events: Array<{ eventId: string; roundId: string; kind: string; body: unknown }>; integrityErrors: readonly string[]; conflictedRoundIds: string[] }>;
  projects?: DaoRead<Array<{ slug: string; title: string; plans: Array<{ slug: string; title: string; status: string; owner: string | null; itemCount: number }> }>>;
}
