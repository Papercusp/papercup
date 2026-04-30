'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import dynamic from 'next/dynamic';
import * as Tabs from '@radix-ui/react-tabs';
import { Pencil, Network, PencilRuler } from 'lucide-react';

const WriteView = dynamic(() => import('./WriteView').then((m) => m.WriteView), { ssr: false });
const MapView = dynamic(() => import('./MapView').then((m) => m.MapView), { ssr: false });
const CanvasView = dynamic(() => import('./CanvasView').then((m) => m.CanvasView), { ssr: false });
const BrainstormChat = dynamic(() => import('./BrainstormChat'), { ssr: false });

type SubTab = 'write' | 'map' | 'canvas';

const TOOLS: Array<{ id: SubTab; icon: typeof Pencil; label: string; caption: string }> = [
  { id: 'write', icon: Pencil, label: 'write', caption: 'shape the spec in rich notes' },
  { id: 'map', icon: Network, label: 'map', caption: 'turn notes into a dependency map' },
  { id: 'canvas', icon: PencilRuler, label: 'canvas', caption: 'sketch flows, branches, and UX ideas' },
];

export function BrainstormFull({ slug }: { slug: string }) {
  const [sub, setSub] = useQueryState(
    'brainstormTab',
    parseAsStringEnum<SubTab>(['write', 'map', 'canvas']).withDefault('write'),
  );
  const [md, setMd] = useState('');
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const activeTool = useMemo(() => TOOLS.find((t) => t.id === sub) ?? TOOLS[0], [sub]);

  const workspacePanel = (
    <Tabs.Root value={sub} onValueChange={(v) => setSub(v as SubTab)} asChild>
      <section className="h-panel h-bsfull-panel primary" aria-label="Brainstorm workspace">
        <div className="h-panel-head h-bsfull-head">
          <div className="h-bsfull-titleblock">
            <span className="h-panel-title">brainstorm workspace</span>
            <span className="h-bsfull-caption">{activeTool.caption}</span>
          </div>
          <Tabs.List className="h-bsfull-subtabs" aria-label="Brainstorm views">
            {TOOLS.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id} className="h-bsfull-sub">
                <t.icon size={12} />
                <span>{t.label}</span>
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>
        <Tabs.Content value="write" className="h-bsfull-main">
          <WriteView slug={slug} onMarkdownChange={setMd} />
        </Tabs.Content>
        <Tabs.Content value="map" className="h-bsfull-main">
          <MapView markdown={md} />
        </Tabs.Content>
        <Tabs.Content value="canvas" className="h-bsfull-main">
          <CanvasView slug={slug} />
        </Tabs.Content>
      </section>
    </Tabs.Root>
  );

  const partnerPanel = (
    <section className="h-panel h-bsfull-panel partner" aria-label="Brainstorm partner">
      <div className="h-panel-head h-bsfull-head">
        <div className="h-bsfull-titleblock">
          <span className="h-panel-title">brainstorm partner</span>
          <span className="h-bsfull-caption">Claude keeps the thread warm while you explore.</span>
        </div>
        <span className="h-bsfull-live">ready</span>
      </div>
      <div className="h-bsfull-partner-body">
        <BrainstormChat slug={slug} />
      </div>
    </section>
  );

  return (
    <div className={`h-bsfull tool-${sub}`}>
      {isCompact ? (
        <div className="h-bsfull-stack">
          {workspacePanel}
          {partnerPanel}
        </div>
      ) : (
        <div className="h-bsfull-grid">
          {workspacePanel}
          {partnerPanel}
        </div>
      )}
    </div>
  );
}
