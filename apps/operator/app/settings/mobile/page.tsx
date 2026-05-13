'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface QrPayload {
  server: string;
  pairToken: string;
  workspaceId: string;
}

interface PairedDevice {
  device_id: string;
  device_label: string | null;
  paired_at: string;
  last_seen: string | null;
  workspace_id: string;
}

interface MintResp {
  qrPayload: QrPayload;
  expiresAt: number;
}

interface WorkspaceOption {
  id: string;
  name: string;
}

export default function MobileSettingsPage() {
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState('default');
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    refreshDevices();
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return;
      const body = (await res.json()) as { current?: string; workspaces?: WorkspaceOption[] };
      const list = body.workspaces ?? [];
      setWorkspaces(list);
      if (body.current) setWorkspaceId(body.current);
      else if (list.length > 0) setWorkspaceId(list[0].id);
    } catch {
      /* ignore — falls back to "default" */
    }
  };

  const refreshDevices = async () => {
    try {
      const res = await fetch('/api/mobile/desktop/devices');
      if (!res.ok) return;
      const body = (await res.json()) as { devices: PairedDevice[] };
      setDevices(body.devices);
    } catch {
      /* ignore */
    }
  };

  const mint = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/mobile/desktop/mint-pair-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as MintResp;
      setQr(body.qrPayload);
      setExpiresAt(body.expiresAt);
    } catch (e) {
      toast.error(`Pair-token mint failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setQr(null);
    setExpiresAt(0);
  };

  const revoke = async (deviceId: string) => {
    const ok = await askConfirm({
      title: 'Revoke this device?',
      body: 'It will need to re-pair to use Operator Mobile.',
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetch(`/api/mobile/desktop/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      toast.success('Device revoked');
      refreshDevices();
    } catch (e) {
      toast.error(`Revoke failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const remainingMs = qr ? Math.max(0, expiresAt - now) : 0;
  const remainingS = Math.floor(remainingMs / 1000);

  return (
    <div className="space-y-8 p-6">
      {confirmEl}
      <header>
        <h1 className="text-xl font-semibold">Mobile access</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Pair the Operator Mobile app on your phone to monitor harnesses, voice-control the operator, and receive intervention pushes when away from your desk.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Pair a new device</h2>

        {!qr && (
          <div className="mt-4 flex items-center gap-3">
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm"
            >
              {workspaces.length === 0 ? (
                <option value={workspaceId}>{workspaceId}</option>
              ) : (
                workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.id})</option>
                ))
              )}
            </select>
            <button
              onClick={mint}
              disabled={busy}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
            >
              {busy ? 'Generating…' : 'Show QR code'}
            </button>
          </div>
        )}

        {qr && (
          <div className="mt-4 flex flex-col items-center gap-4">
            <QRSvg payload={qr} />
            <div className="text-xs text-neutral-500">
              Expires in {Math.floor(remainingS / 60)}:{String(remainingS % 60).padStart(2, '0')}
            </div>
            <p className="max-w-md text-center text-xs text-neutral-500">
              On your phone, open PaperCusp → "Scan QR" → point at this code. Or use the manual code below.
            </p>
            <ManualPayloadBox payload={qr} />
            <button
              onClick={cancel}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Paired devices</h2>
        {devices.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">No devices paired yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {devices.map((d) => (
              <li
                key={d.device_id}
                className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium">{d.device_label ?? '(unnamed)'}</div>
                  <div className="text-xs text-neutral-500">
                    workspace {d.workspace_id} • paired {new Date(d.paired_at).toLocaleString()}
                    {d.last_seen ? ` • last seen ${new Date(d.last_seen).toLocaleString()}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => revoke(d.device_id)}
                  className="rounded-md border border-red-800/50 px-2 py-1 text-xs text-red-400 hover:bg-red-950/30"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * QR rendered server-side via /api/mobile/qr.svg. The phone's barcode scanner
 * reads the JSON payload directly from the SVG.
 */
function ManualPayloadBox({ payload }: { payload: QrPayload }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(payload);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the text and copy manually');
    }
  };
  return (
    <div className="w-full max-w-md space-y-2 rounded-lg border-2 border-cyan-700/40 bg-neutral-950 p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-cyan-300">Manual pair payload</div>
        <button
          onClick={copy}
          className="rounded-md border border-cyan-700/60 bg-cyan-950/40 px-3 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-900/60"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        rows={3}
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 p-2 font-mono text-xs text-cyan-200 outline-none focus:border-cyan-500"
      />
      <p className="text-[11px] text-neutral-500">
        Paste this into the phone's "Manual pair code" field — it contains the server URL and token together.
      </p>
    </div>
  );
}

function QRSvg({ payload }: { payload: QrPayload }) {
  const json = JSON.stringify(payload);
  const src = `/api/mobile/qr.svg?payload=${encodeURIComponent(json)}`;
  return (
    <div className="flex flex-col items-center gap-2">
      <img
        src={src}
        alt="Pairing QR code"
        className="h-64 w-64 rounded-md bg-white p-2"
      />
    </div>
  );
}
