/**
 * Per-harness Autobase wiring.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-030.
 *
 * Build an Autobase on top of a Corestore. The `apply` function
 * recognizes two op kinds:
 *
 *   { type: 'addWriter', key: <hex Hypercore key> }
 *     — installs a new writer; subsequent appends from that writer
 *       are merged into the view.
 *
 *   { type: 'put' | 'del', table, key, value?, schema_version, ts }
 *     — opaque Hyperbee write op. Appended to the merged view; the
 *       projection layer consumes it on read.
 *
 * Schema-version handling (D-024) lives in `schema-version.ts` and
 * gates ops BEFORE the apply call. Unknown-newer ops never reach
 * the view.
 */

import Autobase from 'autobase';
import type Corestore from 'corestore';

export interface OpEnvelope {
  type: 'put' | 'del' | 'addWriter';
  // For addWriter:
  key?: string;
  // For put/del:
  table?: string;
  hbKey?: string;
  value?: unknown;
  schema_version?: number;
  ts?: number;
}

export interface AutobaseHarnessHandle {
  base: Autobase;
  close(): Promise<void>;
  append(op: OpEnvelope): Promise<void>;
}

export interface CreateAutobaseOpts {
  store: Corestore;
  /**
   * For non-bootstrap writers, the bootstrap writer's hypercore key
   * as a Buffer or hex string. Omit on the bootstrap writer itself.
   */
  bootstrap?: string | Buffer | null;
  /**
   * Schema-version gate. Returns true to accept the op, false to
   * drop it (and emit the alert in the caller — pure decision here).
   */
  acceptOp?: (op: OpEnvelope) => boolean;
}

/**
 * The view is a Hypercore that the projection layer consumes. We
 * don't compose Hyperbee here directly — that's a thin wrapper the
 * projection takes responsibility for so each harness can lay out
 * keys per `hyperbee-key-types.ts` independently of Autobase.
 */
function openView(store: Corestore): unknown {
  return store.get({ name: 'view' });
}

function buildApply(opts: CreateAutobaseOpts) {
  return async function apply(
    nodes: ReadonlyArray<{ value: OpEnvelope }>,
    view: { append: (op: unknown) => Promise<void> },
    host: { addWriter: (key: Buffer) => Promise<void> },
  ): Promise<void> {
    for (const node of nodes) {
      const op = node.value;
      if (opts.acceptOp && !opts.acceptOp(op)) continue;
      if (op?.type === 'addWriter' && typeof op.key === 'string') {
        await host.addWriter(Buffer.from(op.key, 'hex'));
        continue;
      }
      await view.append(op);
    }
  };
}

export async function createAutobaseHarness(
  opts: CreateAutobaseOpts,
): Promise<AutobaseHarnessHandle> {
  const bootstrap = opts.bootstrap
    ? (typeof opts.bootstrap === 'string' ? Buffer.from(opts.bootstrap, 'hex') : opts.bootstrap)
    : null;
  const apply = buildApply(opts) as unknown as ConstructorParameters<typeof Autobase>[2]['apply'];
  const open = openView as unknown as ConstructorParameters<typeof Autobase>[2]['open'];
  const base = new Autobase(opts.store, bootstrap, { apply, open });
  await base.ready();

  return {
    base,
    async append(op: OpEnvelope): Promise<void> {
      await base.append(op);
    },
    async close(): Promise<void> {
      await base.close();
    },
  };
}
