/**
 * read-loop.ts — drive the Hyperbee→PG read-side projection at runtime.
 *
 * Closes the long-standing P-031 gap (see projection.ts header): the write-side
 * helpers append ops to each harness's Autobase, but until now NOTHING replayed
 * the merged view back into Postgres — the substrate was write-only, so no harness
 * state ever round-tripped PG↔Hyperbee.
 *
 * This loop subscribes to a harness's merged Autobase view and replays the current
 * rows into PG via `applyHyperbeeOpToPg` (which is idempotent — INSERT … ON CONFLICT
 * / guarded UPDATE). Started from boot.ts when the substrate boots; stopped on close.
 *
 * Design notes:
 * - It is a CURRENT-STATE projection, not an op-log replay: on each change it reads
 *   the latest-per-row KV (`readAllRows`) and upserts every row. Because the apply
 *   is idempotent, re-applying converges and replays after writer-add are safe.
 * - Ticks are length-guarded (skip when the view core length is unchanged) and
 *   coalesced (a tick in flight suppresses overlapping ticks), so an idle harness
 *   costs one cheap length read per interval and zero PG work.
 * - Every collaborator is injectable so the loop logic is unit-testable with no live
 *   Autobase or PG (see read-loop.test.ts).
 *
 * Follow-ups (tracked in the dogfood substrate plan, not done here):
 * - pg_notify → SSE fan-out so the operator UI invalidates on remote-driven rows.
 * - watermark persistence across restarts (today the loop re-projects current state
 *   on boot, which is correct but O(rows) once per boot).
 */

import type { AutobaseHandle } from './autobase-setup'
import type { HyperbeeOp } from './projections'
import { readAllRows } from './read-model'
import { applyHyperbeeOpToPg } from './projection'

export type ReadLoopHandle = {
	/** Stop the loop and detach all listeners/timers. Idempotent. */
	stop: () => void
	/** Force one projection pass now; resolves with the number of rows applied. */
	flush: (force?: boolean) => Promise<number>
}

export type ReadLoopOpts = {
	workspaceId: string
	harnessSlug: string
	/** Floor poll interval in ms. 0 disables the timer (event-driven only — used by tests). Default 2000. */
	intervalMs?: number
	/** Apply one op to PG. Injectable for tests; defaults to the real idempotent projection. */
	apply?: (op: HyperbeeOp) => Promise<unknown>
	/** Read current merged rows. Injectable for tests; defaults to readAllRows. */
	readRows?: (handle: AutobaseHandle) => Promise<HyperbeeOp[]>
	/** Cheap monotonic "has the view advanced" probe. Injectable for tests. */
	viewLength?: () => number
	onError?: (e: unknown) => void
}

function defaultViewLength(handle: AutobaseHandle): number {
	const base: any = (handle as any)?.base
	// Autobase's own merged view is a Hyperbee; its growth shows up as version /
	// underlying core length depending on the autobase build. Be defensive.
	const v = base?.view
	const n = v?.version ?? v?.core?.length ?? v?.length ?? base?.length ?? 0
	return Number.isFinite(n) ? Number(n) : 0
}

export function startHyperbeeReadLoop(
	handle: AutobaseHandle,
	opts: ReadLoopOpts,
): ReadLoopHandle {
	const apply =
		opts.apply ?? ((op: HyperbeeOp) => applyHyperbeeOpToPg(op, { harnessSlug: opts.harnessSlug }))
	const readRows = opts.readRows ?? readAllRows
	const viewLength = opts.viewLength ?? (() => defaultViewLength(handle))
	const intervalMs = Number.isFinite(opts.intervalMs as number) ? (opts.intervalMs as number) : 2000

	let stopped = false
	let running = false
	let appliedAtLen = -1

	async function flush(force = false): Promise<number> {
		if (stopped || running) return 0
		const len = viewLength()
		if (!force && len === appliedAtLen) return 0
		running = true
		let applied = 0
		try {
			const rows = await readRows(handle)
			for (const op of rows) {
				if (stopped) break
				try {
					await apply(op)
					applied++
				} catch (e) {
					opts.onError?.(e)
				}
			}
			appliedAtLen = len
		} catch (e) {
			opts.onError?.(e)
		} finally {
			running = false
		}
		return applied
	}

	const base: any = (handle as any)?.base
	const onUpdate = () => {
		void flush(true)
	}
	try {
		base?.on?.('update', onUpdate)
	} catch {
		/* base may not be an emitter in tests */
	}

	const timer = intervalMs > 0 ? setInterval(() => void flush(false), intervalMs) : null
	if (timer && typeof (timer as any).unref === 'function') (timer as any).unref()

	// Initial catch-up: project whatever is already in the view at boot.
	void flush(true)

	return {
		stop() {
			stopped = true
			if (timer) clearInterval(timer)
			try {
				base?.off?.('update', onUpdate)
			} catch {
				/* no-op */
			}
		},
		flush,
	}
}
