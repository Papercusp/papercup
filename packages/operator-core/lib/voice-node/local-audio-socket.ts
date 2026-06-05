/**
 * Local voice audio socket — the dedicated binary channel between the local
 * client (pui / desktop) and this operator's voice node (D-010).
 *
 * Why not the main IPC socket: that protocol has no client→server binary frame
 * type, and audio shouldn't share a pipe with bursty tool traffic. This socket
 * speaks the same `[4B len BE][1B type][payload]` framing (P-003-proven):
 *
 *   0x01 CTRL  (both ways, UTF-8 JSON)
 *     client→server: {op:'join', channel} | {op:'leave'} | {op:'mute', muted} | {op:'status'}
 *                  | {op:'channels'} | {op:'create', name}
 *     server→client: {ev:'status', status} | {ev:'channels', channels} | {ev:'error', message}
 *   0x02 MIC   (client→server)  raw PCM16-LE mono 48kHz — any chunking; server reframes
 *   0x03 MIX   (server→client)  one mixed 20ms PCM16-LE frame (1920 bytes), 50/s while in a channel
 *
 * Discovery: `~/.papercusp/voice-ipc.json` → { socketPath, sampleRate, frameSamples }.
 * (A bootstrap discovery file — the sanctioned file-not-PG case.)
 */
import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FrameDecoder, encodeFrame } from '@papercusp/p2p-voice';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './codec';
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  onMixedFrame,
  onVoiceStatusChanged,
  pushMicFrame,
  setVoiceMuted,
  voiceStatus,
} from './manager';
import { createVoiceChannel, listVoiceChannels } from './registry';

const CTRL = 0x01;
const MIC = 0x02;
const MIX = 0x03;

const FRAME_BYTES = VOICE_FRAME_SAMPLES * 2;
const te = new TextEncoder();

let server: Server | null = null;
let socketPath: string | null = null;
const clients = new Set<Socket>();
const managerUnsubs: Array<() => void> = [];

function send(sock: Socket, type: number, payload: Uint8Array): void {
  if (sock.destroyed) return;
  try {
    sock.write(encodeFrame(type, payload));
  } catch {
    /* client went away mid-write */
  }
}

function sendCtrl(sock: Socket, msg: unknown): void {
  send(sock, CTRL, te.encode(JSON.stringify(msg)));
}

function broadcastCtrl(msg: unknown): void {
  const payload = te.encode(JSON.stringify(msg));
  for (const c of clients) send(c, CTRL, payload);
}

async function handleCtrl(sock: Socket, raw: Uint8Array): Promise<void> {
  let msg: { op?: string; channel?: string; muted?: boolean; name?: string };
  try {
    msg = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    sendCtrl(sock, { ev: 'error', message: 'bad ctrl json' });
    return;
  }
  try {
    switch (msg.op) {
      case 'join': {
        const status = await joinVoiceChannel(String(msg.channel ?? ''));
        sendCtrl(sock, { ev: 'status', status });
        break;
      }
      case 'leave': {
        const status = await leaveVoiceChannel();
        sendCtrl(sock, { ev: 'status', status });
        break;
      }
      case 'mute': {
        setVoiceMuted(Boolean(msg.muted));
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
        break;
      }
      case 'channels': {
        sendCtrl(sock, { ev: 'channels', channels: await listVoiceChannels() });
        break;
      }
      case 'create': {
        await createVoiceChannel(String(msg.name ?? ''));
        sendCtrl(sock, { ev: 'channels', channels: await listVoiceChannels() });
        break;
      }
      case 'status':
      default:
        sendCtrl(sock, { ev: 'status', status: voiceStatus() });
    }
  } catch (err) {
    sendCtrl(sock, { ev: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function handleClient(sock: Socket): void {
  clients.add(sock);
  const decoder = new FrameDecoder();
  // Mic byte accumulator: clients may chunk arbitrarily; reframe to exact 20ms.
  let micAcc = new Uint8Array(0);

  sock.on('data', (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(new Uint8Array(chunk));
    } catch {
      sock.destroy();
      return;
    }
    for (const f of frames) {
      if (f.type === CTRL) {
        void handleCtrl(sock, f.payload);
      } else if (f.type === MIC) {
        if (micAcc.length === 0 && f.payload.length % FRAME_BYTES === 0) {
          // fast path: exact frames, no copy accumulation
          for (let off = 0; off + FRAME_BYTES <= f.payload.length; off += FRAME_BYTES) {
            const slice = f.payload.subarray(off, off + FRAME_BYTES);
            pushMicFrame(new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + FRAME_BYTES)));
          }
        } else {
          const next = new Uint8Array(micAcc.length + f.payload.length);
          next.set(micAcc, 0);
          next.set(f.payload, micAcc.length);
          micAcc = next;
          let off = 0;
          while (off + FRAME_BYTES <= micAcc.length) {
            const slice = micAcc.subarray(off, off + FRAME_BYTES);
            pushMicFrame(new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + FRAME_BYTES)));
            off += FRAME_BYTES;
          }
          micAcc = micAcc.subarray(off);
        }
      }
    }
  });
  sock.on('error', () => clients.delete(sock));
  sock.on('close', () => clients.delete(sock));
  sendCtrl(sock, { ev: 'status', status: voiceStatus() });
}

export interface VoiceSocketInfo {
  socketPath: string;
  discoveryPath: string;
}

export function startLocalVoiceSocket(): VoiceSocketInfo {
  if (server && socketPath) {
    return { socketPath, discoveryPath: join(homedir(), '.papercusp', 'voice-ipc.json') };
  }
  const dir = join(homedir(), '.papercusp', 'sockets');
  mkdirSync(dir, { recursive: true });
  socketPath = join(dir, `voice-${process.pid}.sock`);
  try {
    rmSync(socketPath, { force: true });
  } catch {
    /* fresh path */
  }
  server = createServer(handleClient);
  server.on('error', (err) => console.error('[voice-socket] server error:', err));
  server.listen(socketPath);

  // Mixed frames fan out to every connected client; status pushes on change.
  managerUnsubs.push(
    onMixedFrame((frame) => {
      if (clients.size === 0) return;
      const bytes = new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
      for (const c of clients) send(c, MIX, bytes);
    }),
    onVoiceStatusChanged((status) => broadcastCtrl({ ev: 'status', status })),
  );

  const discoveryPath = join(homedir(), '.papercusp', 'voice-ipc.json');
  writeFileSync(
    discoveryPath,
    JSON.stringify({ socketPath, sampleRate: VOICE_SAMPLE_RATE, frameSamples: VOICE_FRAME_SAMPLES }, null, 2),
  );
  return { socketPath, discoveryPath };
}

export function stopLocalVoiceSocket(): void {
  for (const un of managerUnsubs.splice(0)) un();
  for (const c of clients) c.destroy();
  clients.clear();
  server?.close();
  server = null;
  if (socketPath) {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* gone */
    }
    socketPath = null;
  }
}
