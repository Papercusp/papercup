'use client';

import { memo, useDeferredValue, useEffect, useMemo, useRef } from 'react';
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
  // Defer the heavy command list. The palette dialog mounts and the
  // input becomes interactive on the first paint; the items render on
  // a subsequent low-priority React render. With ~400 commands this
  // turns a perceived ~1s open into <100ms (the user can already start
  // typing while items are filling in).
  const deferredCommands = useDeferredValue(commands);

  // Focus the input on open. We're using forceMount so the dialog
  // tree is always in the DOM — Radix's onOpenAutoFocus doesn't
  // reliably fire in that mode, so we drive focus from `open`.
  // requestAnimationFrame lets Radix flip data-state="open" + the CSS
  // visibility:hidden override clears before we focus; Firefox refuses
  // to move focus to an element that's still computed-hidden.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Clear the search input when closing so the next open starts fresh.
  useEffect(() => {
    if (!open && inputRef.current) inputRef.current.value = '';
  }, [open]);

  const run = (c: Command) => {
    c.perform();
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }} modal={false}>
      {/*
        forceMount keeps the dialog tree in the DOM (just hidden) so
        opening is a CSS state toggle instead of a fresh mount + render
        of ~400 cmdk items + Radix portal scaffolding. This is the
        single biggest win for perceived open latency: the user no
        longer pays for cmdk's first paint when they press the key.
      */}
      <Dialog.Portal forceMount>
        <Dialog.Overlay className="h-cmd-overlay" data-anim="fade" forceMount />
        <Dialog.Content
          forceMount
          className="h-cmd"
          data-anim="slide-down"
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
                ref={inputRef}
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

              <CommandList commands={deferredCommands} run={run} />
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

/**
 * The command list is split out + memoized so React's deferred-render
 * scheduler can keep the dialog shell paint-priority while this mounts
 * its hundreds of `<CmdK.Item>` children at low priority.
 */
const CommandList = memo(function CommandList({
  commands,
  run,
}: {
  commands: Command[];
  run: (c: Command) => void;
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

  return (
    <>
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
    </>
  );
});
