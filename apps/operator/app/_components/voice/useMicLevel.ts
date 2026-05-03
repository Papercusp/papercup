/**
 * useMicLevel — drives a CSS custom property on a target element with
 * the live mic level (0..1). Writes directly to the DOM via a ref
 * instead of React state so the 60fps RMS updates don't re-render the
 * component (or any of its parents — VoiceButton sits in the chrome
 * header, so a state-based version churned the whole shell).
 *
 * Engine-independent: opens its own getUserMedia stream + AnalyserNode
 * solely for visualization, so all 3 STT engines (Voicemode, WebSpeech,
 * Deepgram) light up the same way without sharing the capture stream.
 */

import { useEffect, useRef } from 'react';

export function useMicLevel(active: boolean): {
  ref: React.RefObject<HTMLElement>;
} {
  const ref = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.style.setProperty('--mic-level', '0');
    if (!active) return;
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          const eased = Math.min(1, Math.max(0, (rms - 0.02) * 6));
          // Direct DOM write — bypasses React entirely.
          if (ref.current) ref.current.style.setProperty('--mic-level', eased.toFixed(3));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        /* permission denied / device busy — silent fallback */
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try { ctxRef.current?.close(); } catch { /* ignore */ }
      ctxRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (ref.current) ref.current.style.setProperty('--mic-level', '0');
    };
  }, [active]);

  return { ref };
}
