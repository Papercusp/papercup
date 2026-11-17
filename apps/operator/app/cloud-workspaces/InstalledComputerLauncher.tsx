"use client";

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/app/harness/Button';
import { Modal } from '@/app/harness/Modal';
import { encodeInstalledComputerRequest, installedComputerUrl, type InstalledComputerRequest } from './installed-computer-protocol';
import { installedBrowserKey, installedComputerPrincipal, readInstalledComputerApproval, saveInstalledComputerApproval,
  type InstalledComputerPrincipal } from './installed-computer-connection';

/** Shared by the portal shell's machine switcher and the local shell. */
export function InstalledComputerLauncher() {
  const [visible, setVisible] = useState(false);
  const [request, setRequest] = useState<InstalledComputerRequest | null>(null);
  const [principal, setPrincipal] = useState<InstalledComputerPrincipal | null>(null);
  const [address, setAddress] = useState('http://127.0.0.1:3070');
  const [receipt, setReceipt] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const popup = useRef<Window | null>(null);
  const localOrigin = useRef<string | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const current = ++epoch.current;
    setRequest(null); setPrincipal(null); setError(''); setStatus('Preparing this browser…');
    void Promise.all([installedBrowserKey(), installedComputerPrincipal()]).then(([keys, identity]) => {
      if (current !== epoch.current) return;
      setPrincipal(identity);
      setRequest({ version: 1, requestId: crypto.randomUUID(), portalOrigin: location.origin,
        browserPublicKey: keys.publicKey.toString('base64') });
      setStatus('Open the installed app, review the account and workspace, and approve desktop access there.');
    }).catch(cause => { if (current === epoch.current) { setStatus(''); setError(String(cause.message ?? cause)); } });
    return () => { epoch.current++; };
  }, [visible]);

  async function accept(value: unknown) {
    if (!request || !principal) return;
    const current = epoch.current;
    const identity = await installedComputerPrincipal();
    if (current !== epoch.current) return;
    if (JSON.stringify(identity) !== JSON.stringify(principal)) throw new Error('The portal account or workspace changed. Reopen Connect your computer.');
    const approved = readInstalledComputerApproval(value, request, identity);
    if (!approved) throw new Error('The approval does not match this browser, request, account and workspace.');
    saveInstalledComputerApproval(approved, identity);
    setError('');
    setStatus('Approval saved. Choose this computer from Machine to verify its encrypted desktop connection.');
  }

  useEffect(() => {
    if (!request || !visible) return;
    const receive = (event: MessageEvent) => {
      if (!popup.current || event.source !== popup.current || event.origin !== localOrigin.current) return;
      void accept(event.data).catch(cause => setError(String(cause.message ?? cause)));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [request, principal, visible]);

  return <span>
    <Button variant="ghost" onClick={() => setVisible(true)}>Connect your computer</Button>
    <Modal open={visible} onOpenChange={setVisible} title="Connect your computer"
      contentStyle={{ width: 'min(40rem, 100%)', padding: '1.25rem' }}>
    <section aria-label="Connect your computer">
      <h2>Connect your computer</h2>
      <Button variant="ghost" onClick={() => setVisible(false)}>Close connection setup</Button>
      <p>Use the Papercusp app already installed on your computer.</p>
      {principal ? <p>Portal account {principal.userId} · Organization {principal.organizationId} · Workspace {principal.workspaceId}</p> : null}
      <label>Papercusp app address <input value={address} onChange={event => setAddress(event.target.value)} /></label>
      <Button disabled={!request} onClick={() => {
        try {
          const url = installedComputerUrl(address, request!);
          localOrigin.current = new URL(url).origin;
          popup.current = window.open(url, 'papercusp-local-connect');
          setError('');
          setStatus(popup.current ? 'Waiting for local approval. If the app is stopped or this version lacks desktop access, start or update it, then open it again. You can also paste the code in the app’s Connect to portal screen.' : 'The browser blocked the app window. Allow it, or copy the code into the running app.');
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Open Papercusp</Button>
      <label>Public connection code <textarea readOnly value={request ? encodeInstalledComputerRequest(request) : ''} /></label>
      <Button disabled={!request} onClick={() => {
        void navigator.clipboard.writeText(encodeInstalledComputerRequest(request!)).then(() => setStatus('Connection code copied. Paste it in the app’s Connect to portal screen.'), () => setError('Select and copy the connection code above.'));
      }}>Copy connection code</Button>
      <p>If the app cannot return automatically, copy its approval receipt below. Opening a window or saving approval does not mean a desktop is connected.</p>
      <label>Local approval receipt <textarea value={receipt} onChange={event => setReceipt(event.target.value)} /></label>
      <Button disabled={!request || !receipt} onClick={() => {
        try {
          if (receipt.length > 16384) throw new Error('Approval receipt is too large.');
          void accept(JSON.parse(atob(receipt.trim()))).catch(cause => setError(String(cause.message ?? cause)));
        } catch { setError('The approval receipt is invalid.'); }
      }}>Verify approval</Button>
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
    </Modal>
  </span>;
}
