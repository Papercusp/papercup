'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri, wslStatus, type WslStatus } from '@/lib/wsl-tauri';
import { Select } from '@/app/harness/Select';
import { f32ToWav } from '../voice/f32-to-wav';

type PermState = 'unknown' | 'granted' | 'denied' | 'prompt' | 'unsupported';

interface PermDef {
  readonly id: 'microphone' | 'notifications' | 'accessibility';
  readonly title: string;
  readonly why: string;
  readonly platforms: ReadonlyArray<'mac' | 'linux' | 'windows'>;
  readonly request: () => Promise<PermState>;
  readonly probe: () => Promise<PermState>;
}

async function probeMicrophone(): Promise<PermState> {
  if (typeof navigator === 'undefined' || !navigator.permissions) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unknown';
  }
}
async function requestMicrophone(): Promise<PermState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

async function probeNotifications(): Promise<PermState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  const p = Notification.permission;
  if (p === 'granted') return 'granted';
  if (p === 'denied') return 'denied';
  return 'prompt';
}
async function requestNotifications(): Promise<PermState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') return 'granted';
    if (result === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'denied';
  }
}

// Accessibility can only be granted from the macOS System Settings UI;
// there is no browser/Tauri API to request it programmatically. The
// best we can do is open a link to the system pane.
async function probeAccessibility(): Promise<PermState> {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (!/Mac/i.test(navigator.platform)) return 'unsupported';
  return 'unknown';
}
async function requestAccessibility(): Promise<PermState> {
  if (typeof window !== 'undefined') {
    window.open(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      '_blank',
    );
  }
  return 'unknown';
}

const PERMS: readonly PermDef[] = [
  {
    id: 'microphone',
    title: 'Microphone',
    why: "Required for any voice mode (continuous, hybrid, or single-utterance). Skip if you don't plan to use voice.",
    platforms: ['mac', 'linux', 'windows'],
    request: requestMicrophone,
    probe: probeMicrophone,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    why: 'Lets Papercusp alert you when an agent run finishes, hits an error, or needs your input.',
    platforms: ['mac', 'linux', 'windows'],
    request: requestNotifications,
    probe: probeNotifications,
  },
  {
    id: 'accessibility',
    title: 'Accessibility (macOS only)',
    why: 'Required if you want global keyboard shortcuts to work outside the app window.',
    platforms: ['mac'],
    request: requestAccessibility,
    probe: probeAccessibility,
  },
];

export function StepOsPermissions() {
  const [states, setStates] = useState<Record<string, PermState>>({});
  const [wsl, setWsl] = useState<WslStatus | null>(null);

  // ── Voice device section state (merged in from the former
  //    standalone Voice-devices step) ───────────────────────────────
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('');
  const [selectedOutput, setSelectedOutput] = useState<string>('');
  const [level, setLevel] = useState(0);
  const [recordings, setRecordings] = useState<{ url: string; createdAt: number }[]>([]);
  const [recording, setRecording] = useState(false);
  // Diagnostic readout for the test recording (shown on-page) so capture
  // failures on WebKitGTK are observable end-to-end.
  const [recInfo, setRecInfo] = useState<string>('');
  const [tonePlaying, setTonePlaying] = useState(false);
  const [sinkIdSupported, setSinkIdSupported] = useState(true);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  // The test recording captures PCM via Web Audio (MediaRecorder supports no
  // audio mime on the WebKitGTK webview), inline + self-contained so its
  // outcome is observable (recInfo). recStopRef holds a teardown that returns
  // the captured samples + diagnostics.
  const recStopRef = useRef<null | (() => { samples: Float32Array; rate: number; frames: number; ctxState: string })>(null);
  const recTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toneCtxRef = useRef<AudioContext | null>(null);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);

  const micGranted = states['microphone'] === 'granted';

  // The Node server can't read macOS TCC state — only the renderer can
  // call navigator.permissions / Notification.permission. We PATCH the
  // aggregate result back into setup_wizard_state so the sidebar badge
  // (driven by setup-status) flips green when mic + notifications
  // resolve granted. Accessibility is unprobable; we ignore it for the
  // aggregate (granting it is encouraged but not required for "ok").
  const syncToServer = useCallback(async (next: Record<string, PermState>) => {
    if (typeof navigator === 'undefined' || !/Mac/i.test(navigator.platform)) return;
    const required: Array<PermDef['id']> = ['microphone', 'notifications'];
    const ok = required.every((id) => next[id] === 'granted');
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ os_permissions_ok: ok }),
      });
    } catch {
      // best effort; sidebar will retry on next probe
    }
  }, []);

  const probeAll = useCallback(async () => {
    const next: Record<string, PermState> = {};
    await Promise.all(
      PERMS.map(async (p) => {
        next[p.id] = await p.probe();
      }),
    );
    setStates(next);
    void syncToServer(next);
    // WSL probe — only meaningful inside the Tauri shell. The
    // WslOnboardingGate in the root layout owns the install flow; we
    // just surface the resolved state for visibility.
    if (isTauri()) {
      try {
        const s = await wslStatus();
        if (s) setWsl(s);
      } catch { /* leave null */ }
    }
  }, [syncToServer]);

  useEffect(() => {
    void probeAll();
  }, [probeAll]);

  const onRequest = async (p: PermDef) => {
    const result = await p.request();
    setStates((prev) => {
      const next = { ...prev, [p.id]: result };
      void syncToServer(next);
      return next;
    });
  };

  // ── Voice device logic ──────────────────────────────────────────
  const enumerate = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    // Drop devices with an empty deviceId. WebKitGTK reports audioinputs with
    // a blank deviceId until a capture stream is live (right after the grant,
    // before the monitor opens) — and an empty id becomes a <Select.Item
    // value="">, which Radix throws on, crashing the whole step into the error
    // boundary. They reappear with real ids once the monitor stream is up.
    const ins = all.filter((d) => d.kind === 'audioinput' && d.deviceId);
    const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId);
    setInputs(ins);
    setOutputs(outs);
    setSelectedInput((cur) => cur || ins[0]?.deviceId || '');
    setSelectedOutput((cur) => cur || outs[0]?.deviceId || 'default');
  }, []);

  useEffect(() => {
    void enumerate();
    if (typeof HTMLAudioElement !== 'undefined') {
      setSinkIdSupported(typeof HTMLAudioElement.prototype.setSinkId === 'function');
    }
  }, [enumerate]);

  // Re-enumerate once mic is granted — labels are empty until then.
  useEffect(() => {
    if (micGranted) void enumerate();
  }, [micGranted, enumerate]);

  const stopMonitor = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    setLevel(0);
  }, []);

  const startMonitor = useCallback(async (deviceId: string) => {
    stopMonitor();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = stream;
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      // WebKitGTK / autoplay policy start the context 'suspended'; an
      // unresumed context never feeds the analyser, so the live meter
      // would sit at zero even with a working mic.
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* best effort */ } }
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      void enumerate();
    } catch {
      // mic was revoked between grant and monitor — reflect it
      setStates((prev) => ({ ...prev, microphone: 'denied' }));
    }
  }, [enumerate, stopMonitor]);

  useEffect(() => () => stopMonitor(), [stopMonitor]);

  useEffect(() => {
    // Start the monitor as soon as the mic is granted, even before a device
    // is picked — startMonitor('') opens the DEFAULT device. This is required
    // on WebKitGTK, where enumerateDevices() reports blank deviceIds until a
    // capture stream is live: opening the default stream populates the ids,
    // which then surface real options in the input dropdown. Gating on
    // selectedInput here deadlocked (no id → no selection → no stream → no id).
    if (micGranted) void startMonitor(selectedInput);
  }, [selectedInput, micGranted, startMonitor]);

  // Apply sinkId to all rendered audio elements when the output changes.
  useEffect(() => {
    if (!sinkIdSupported || !selectedOutput) return;
    audioElsRef.current.forEach((el) => {
      if (el && typeof el.setSinkId === 'function') {
        el.setSinkId(selectedOutput).catch(() => {/* device gone — ignore */});
      }
    });
  }, [selectedOutput, sinkIdSupported, recordings]);

  const startRecording = async () => {
    setRecInfo('opening mic…');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name ?? String(e);
      setRecInfo(`Couldn't open the microphone (${name}) — it may be in use by another app.`);
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* best effort */ } }
    const rate = ctx.sampleRate;
    const track = stream.getAudioTracks()[0];
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let frames = 0;
    node.onaudioprocess = (e) => {
      frames++;
      const d = e.inputBuffer.getChannelData(0);
      const c = new Float32Array(d.length);
      c.set(d);
      chunks.push(c);
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    setRecInfo(`recording… (ctx ${ctx.state}, track ${track?.readyState}${track?.muted ? ', MUTED' : ''})`);
    recStopRef.current = () => {
      try { node.onaudioprocess = null; } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      try { mute.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      const ctxState = ctx.state;
      try { void ctx.close(); } catch { /* ignore */ }
      let total = 0;
      for (const c of chunks) total += c.length;
      const samples = new Float32Array(total);
      let off = 0;
      for (const c of chunks) { samples.set(c, off); off += c.length; }
      return { samples, rate, frames, ctxState };
    };
    setRecording(true);
    recTimerRef.current = setTimeout(() => { void stopRecording(); }, 5000);
  };

  const stopRecording = async () => {
    if (recTimerRef.current) { clearTimeout(recTimerRef.current); recTimerRef.current = null; }
    const teardown = recStopRef.current;
    recStopRef.current = null;
    setRecording(false);
    if (!teardown) { setRecInfo('recording never started (no teardown)'); return; }
    const { samples, rate, frames, ctxState } = teardown();
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    if (samples.length === 0 || peak < 0.002) {
      setRecInfo(`No audio captured — frames=${frames}, samples=${samples.length}, peak=${peak.toFixed(4)}, ctx=${ctxState}, rate=${rate}. (Check the mic isn't muted / right device selected.)`);
      return;
    }
    const url = URL.createObjectURL(f32ToWav(samples, rate));
    setRecordings((prev) => [{ url, createdAt: Date.now() }, ...prev].slice(0, 3));
    setRecInfo(`captured ${frames} frames, peak=${peak.toFixed(3)} — saved.`);
  };

  // 1-second 440Hz tone via Web Audio, routed through an AudioElement
  // so setSinkId controls which speaker it lands on.
  const playTestTone = async () => {
    if (tonePlaying) return;
    setTonePlaying(true);
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      toneCtxRef.current = ctx;
      // Suspended-by-default on WebKitGTK / under autoplay policy — resume
      // or nothing ever sounds.
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* best effort */ } }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.12;
      osc.start();

      // Output routing. Routing a MediaStream through an <audio> element +
      // setSinkId is silent on WebKitGTK (the desktop shell) — it exposes
      // no output devices and no setSinkId. So only take that path when
      // setSinkId is actually supported AND the user picked a specific
      // non-default sink; otherwise play straight to ctx.destination, which
      // honours the system default speaker and is the only path that makes
      // sound on WebKitGTK.
      let audio: HTMLAudioElement | null = null;
      const routeToSink = sinkIdSupported && !!selectedOutput && selectedOutput !== 'default';
      if (routeToSink) {
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        audio = new Audio();
        audio.srcObject = dest.stream;
        try { await audio.setSinkId(selectedOutput); } catch { /* sink gone — still audible on default */ }
        try { await audio.play(); } catch { /* tone is already scheduled on the graph */ }
      } else {
        osc.connect(gain).connect(ctx.destination);
      }

      setTimeout(() => {
        osc.stop();
        if (audio) { audio.pause(); audio.srcObject = null; }
        void ctx.close();
        setTonePlaying(false);
      }, 1000);
    } catch {
      setTonePlaying(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp asks your operating system for these on first use. Grant them now or later — and
        pick the microphone and speaker it should use.
      </p>
      {wsl && wsl.state.kind !== 'NotSupported' && (
        <div className="pc-perm" data-state={wsl.state.kind === 'Ready' ? 'granted' : 'denied'}>
          <div className="pc-perm__head">
            <span className="pc-perm__title">WSL2 environment (Windows only)</span>
            <span className="pc-perm__platforms">
              <span
                className="pc-perm__badge"
                data-state={wsl.state.kind === 'Ready' ? 'granted' : 'denied'}
              >
                {wsl.state.kind === 'Ready' ? '✓ ready' : `⚠ ${wsl.state.kind}`}
              </span>
              <span>windows</span>
            </span>
          </div>
          <p className="pc-perm__why">
            Papercusp's harness runs inside a WSL2 distro on Windows because the toolchain assumes
            POSIX. {wsl.state.kind === 'Ready'
              ? `Distro is set up and ready (WSL version ${wsl.defaultVersion || 2}).`
              : 'Set up by the install gate before the wizard loads — if you see this in a non-ready state, restart the app.'}
          </p>
        </div>
      )}
      <div className="pc-perm-list">
        {PERMS.map((p) => {
          const state = states[p.id] ?? 'unknown';
          return (
            <div key={p.id} className="pc-perm" data-state={state}>
              <div className="pc-perm__head">
                <span className="pc-perm__title">{p.title}</span>
                <span className="pc-perm__platforms">
                  <PermBadge state={state} />
                  <span>{p.platforms.join(' · ')}</span>
                </span>
              </div>
              <p className="pc-perm__why">{p.why}</p>
              <div className="pc-perm__actions">
                {state === 'granted' && (
                  <span className="pc-perm__hint">Already granted — nothing to do.</span>
                )}
                {state === 'denied' && (
                  <span className="pc-perm__hint">
                    Denied. Grant via your system settings if you change your mind.
                  </span>
                )}
                {(state === 'prompt' || state === 'unknown') && (
                  <button
                    type="button"
                    className="pc-btn"
                    onClick={() => void onRequest(p)}
                  >
                    {p.id === 'accessibility' ? 'Open system settings' : 'Request now'}
                  </button>
                )}
                {state === 'unsupported' && (
                  <span className="pc-perm__hint">Not applicable on this platform.</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pc-divider" />

      <h3 className="pc-consent__heading">Microphone &amp; speaker</h3>
      <p className="pc-step__hint">
        The mic that "works" in your system settings often isn't the one a desktop app picks by
        default — pick it here and watch the meter move while you talk.
      </p>

      {!micGranted ? (
        <p className="pc-perm__hint">
          Grant <strong>Microphone</strong> access above to pick and test your audio devices.
        </p>
      ) : (
        <>
          <label className="pc-field">
            <span className="pc-field__label">Input (microphone)</span>
            <Select
              value={selectedInput}
              onChange={setSelectedInput}
              options={inputs.map((d) => ({
                value: d.deviceId,
                label: d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`,
              }))}
              ariaLabel="Input microphone"
            />
          </label>

          <div className="pc-vu">
            <div className="pc-vu__label">Live level</div>
            <div className="pc-vu__bar">
              <div className="pc-vu__fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <div className="pc-vu__hint">
              {level < 0.02
                ? 'Say something — the bar should move.'
                : level < 0.4
                  ? 'Good — speak normally.'
                  : 'Clipping. Move farther from the mic.'}
            </div>
          </div>

          <label className="pc-field">
            <span className="pc-field__label">Output (speaker)</span>
            {sinkIdSupported && outputs.length > 0 ? (
              <Select
                value={selectedOutput}
                onChange={setSelectedOutput}
                options={outputs.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Speaker (${d.deviceId.slice(0, 6)}…)`,
                }))}
                ariaLabel="Output speaker"
              />
            ) : (
              // WebKitGTK (the desktop shell) enumerates no audiooutput
              // devices and has no setSinkId, so a real <Select> would just
              // render blank. Show the only truth there is — playback goes
              // to the system default speaker — instead of an empty dropdown.
              <>
                <Select
                  value="__system_default__"
                  onChange={() => {}}
                  options={[{ value: '__system_default__', label: 'System default speaker' }]}
                  ariaLabel="Output speaker"
                  disabled
                />
                <span className="pc-field__hint">
                  This platform doesn't expose individual output devices — playback uses your
                  system's default speaker. Pick it in your OS sound settings.
                </span>
              </>
            )}
          </label>

          <div className="pc-step__actions">
            <button
              type="button"
              className="pc-btn"
              onClick={() => void playTestTone()}
              disabled={tonePlaying}
            >
              {tonePlaying ? 'Playing…' : 'Test speaker (1 sec tone)'}
            </button>
            {!recording ? (
              <button type="button" className="pc-btn pc-btn--primary" onClick={() => void startRecording()}>
                Record 5-second test
              </button>
            ) : (
              <button type="button" className="pc-btn" onClick={() => void stopRecording()}>
                Stop
              </button>
            )}
          </div>

          {recInfo && (
            <p className="pc-field__hint" role="status" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>
              {recInfo}
            </p>
          )}

          {recordings.length > 0 && (
            <div className="pc-rec-list">
              {recordings.map((r, i) => (
                <audio
                  key={r.createdAt}
                  ref={(el) => {
                    if (el) audioElsRef.current[i] = el;
                  }}
                  controls
                  src={r.url}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PermBadge({ state }: { state: PermState }) {
  const label = {
    granted: '✓ granted',
    denied: '⚠ denied',
    prompt: '? not granted',
    unknown: '? unknown',
    unsupported: '— n/a',
  }[state];
  return <span className="pc-perm__badge" data-state={state}>{label}</span>;
}
