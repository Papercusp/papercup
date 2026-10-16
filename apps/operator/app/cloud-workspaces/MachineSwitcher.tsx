"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { Select } from "@/app/harness/Select";
import { LOCAL_DESKTOP_HOST } from "./local-desktop-protocol";
import type { CloudWorkspacesControlRow, WorkspaceHostControlRow } from "./workspace-view-model";

export interface MachineSwitcherProps {
  localMode?: boolean;
  workspaceSelected?: boolean;
  onSelect?: (hostId: string) => void;
  connectHref?: string;
}

/** Both shells use the existing host inventory; the hosted SyncProvider applies tenant scope. */
export default function MachineSwitcher({ localMode = true, workspaceSelected = true, ...props }: MachineSwitcherProps) {
  if (!localMode && !workspaceSelected) {
    return <span role="status">Choose a workspace to connect a machine</span>;
  }
  return <AuthorizedMachineSwitcher {...props} localMode={localMode} />;
}

function AuthorizedMachineSwitcher({ localMode, onSelect, connectHref }: MachineSwitcherProps) {
  const control = useSyncQuery<CloudWorkspacesControlRow>({ queryName: "workspaceHosts.control" });
  const [target, setTarget] = useQueryStates({
    desktopHost: parseAsString, host: parseAsString, desktop: parseAsString,
    desktopPins: parseAsString, desktopFilter: parseAsString,
  }, { history: "push" });
  return <MachineSwitcherView
    localMode={localMode === true}
    value={target.desktopHost ?? target.host}
    rows={control.data ?? []}
    loading={control.loading}
    error={control.error?.message ?? null}
    connectHref={connectHref}
    onSelect={(hostId) => {
      // The viewer, pins and filter belong to the old machine. No shared registry
      // default or agent lifecycle is written; each window keeps its own URL.
      void setTarget({ desktopHost: hostId, host: hostId === LOCAL_DESKTOP_HOST ? null : hostId,
        desktop: null, desktopPins: null, desktopFilter: null }).then(() => {
        if (onSelect) onSelect(hostId);
        else {
          const url = new URL(window.location.href);
          url.pathname = "/desktops";
          window.location.assign(url.toString());
        }
      });
    }}
  />;
}

export function MachineSwitcherView({ localMode, value, rows, loading, error, onSelect,
  connectHref = "/cloud-workspaces?step=connect" }: {
  localMode: boolean;
  value: string | null;
  rows: CloudWorkspacesControlRow[];
  loading: boolean;
  error: string | null;
  onSelect: (hostId: string) => void;
  connectHref?: string;
}) {
  const machines = rows.filter((row): row is WorkspaceHostControlRow => row.kind === "workspace"
    && row.observedState !== "absent" && row.observedState !== "destroying");
  const selected = value ?? (localMode ? LOCAL_DESKTOP_HOST : machines[0]?.id ?? "");
  const options = [
    ...(localMode ? [{ value: LOCAL_DESKTOP_HOST, label: "This computer" }] : []),
    ...machines.map((row) => ({ value: row.id, label: `${row.name} — ${row.observedState}` })),
  ];
  const missing = selected !== "" && !options.some((option) => option.value === selected);
  if (missing) options.push({ value: selected, label: "Machine unavailable" });
  return <span role="group" aria-label="Machine selection" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <Select ariaLabel="Machine" value={selected} options={options}
      placeholder={loading ? "Loading machines…" : "Choose a machine"}
      disabled={loading}
      onChange={(hostId) => {
        if (options.some((option) => option.value === hostId) && !(missing && hostId === selected)) onSelect(hostId);
      }} />
    <a href={connectHref}>Connect a machine</a>
    {error ? <span role="alert">Machines unavailable: {error}</span> : null}
    {missing && !error ? <span role="status">Choose another machine</span> : null}
  </span>;
}
