'use client';

import { useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command as CmdK } from 'cmdk';
import { KbdHint } from './primitives';

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  section?: string;
  keywords?: string;
  icon?: string;
  shortcut?: string;
  perform: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const c of commands) {
      const key = c.section ?? '';
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }
    return Array.from(groups.entries());
  }, [commands]);

  const run = (c: Command) => {
    c.perform();
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="h-cmd-overlay" />
        <Dialog.Content
          className="h-cmd"
          aria-label="Command palette"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const input = (e.currentTarget as HTMLElement).querySelector('input[cmdk-input]') as HTMLInputElement | null;
            input?.focus();
          }}
        >
          <Dialog.Title style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
            Command palette
          </Dialog.Title>
          <CmdK label="Command palette" loop shouldFilter>
            <div className="h-cmd-inputbar">
              <span className="h-cmd-key">⌘K</span>
              <CmdK.Input
                className="h-cmd-input"
                placeholder="Type a command, feature, run, or project…"
                aria-label="Search commands"
              />
              <span className="h-cmd-esc">esc</span>
            </div>

            <div className="h-cmd-meta">
              <span>quick actions</span>
              <span>Search projects, features, runs, and workspace controls.</span>
            </div>

            <CmdK.List className="h-cmd-list">
              <CmdK.Empty className="h-cmd-empty">
                <strong>No matches</strong>
                <span>Try “start”, “triage”, “docs”, a feature id, or a project name.</span>
              </CmdK.Empty>

              {grouped.map(([section, cmds]) => (
                <CmdK.Group key={section || 'default'} heading={section || undefined} className="h-cmd-group">
                  {cmds.map((c) => (
                    <CmdK.Item
                      key={c.id}
                      value={`${c.title} ${c.subtitle ?? ''} ${c.keywords ?? ''}`}
                      onSelect={() => run(c)}
                      className="h-cmd-row"
                    >
                      <span className="h-cmd-icon" aria-hidden="true">{c.icon ?? '⌁'}</span>
                      <span className="h-cmd-copy">
                        <span className="h-cmd-title">{c.title}</span>
                        {c.subtitle && <span className="h-cmd-subtitle">{c.subtitle}</span>}
                      </span>
                      {c.shortcut && <KbdHint>{c.shortcut}</KbdHint>}
                    </CmdK.Item>
                  ))}
                </CmdK.Group>
              ))}
            </CmdK.List>

            <div className="h-cmd-footer">
              <span><KbdHint>↑↓</KbdHint> navigate</span>
              <span><KbdHint>↵</KbdHint> run</span>
              <span><KbdHint>esc</KbdHint> close</span>
            </div>
          </CmdK>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
