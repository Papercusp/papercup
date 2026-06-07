/**
 * Voice tab (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * Voice tab. Mounts the holepunch `VideoGrid` (the self-contained voice/video
 * session surface — WS bridge, capture, per-peer tiles, control bar) for the
 * active shared harness, gated behind the same `papercusp-video-channels`
 * flag the workbench voice pane uses, plus a deep link to the full voice
 * settings (engines / role voices / spend).
 */
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { Settings2 } from 'lucide-react';
import VideoGrid from '../voice-video/VideoGrid';
import { useResolvedHarnessSlug } from '@/app/adv/create/use-create-data';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';

export default function VoiceTab({ active }: { active: boolean }) {
  const harnessSlug = useResolvedHarnessSlug();
  const videoOn = useFlag(FLAGS.VIDEO_CHANNELS);

  return (
    <div className="pclsb-voice" data-testid="left-sidebar-voice">
      <div className="pclsb-panel__bar" style={{ padding: '4px 12px 0' }}>
        <span className="pclsb-panel__bar-label">
          voice{harnessSlug ? ` · ${harnessSlug}` : ''}
        </span>
        <span className="pclsb-panel__bar-spacer" />
        <button
          type="button"
          className="pclsb-chipbtn"
          onClick={() => navigateClient('/settings/voice')}
          title="Voice settings — engines, role voices, spend"
        >
          <Settings2 size={12} aria-hidden="true" /> settings
        </button>
      </div>
      {active && videoOn && harnessSlug ? (
        <VideoGrid harnessSlug={harnessSlug} className="pclsb-voice__grid" />
      ) : (
        <div className="pclsb-panel__empty" style={{ padding: '24px 16px' }}>
          {videoOn
            ? harnessSlug
              ? ''
              : 'Select a shared harness to join its voice channel.'
            : 'Voice/video channels are flag-gated (papercusp-video-channels) — flip it in /admin/features.'}
        </div>
      )}
    </div>
  );
}
