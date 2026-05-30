/**
 * read-loop.test.ts — unit tests for the Hyperbee→PG read-loop driver.
 *
 * No live Autobase or Postgres: apply / readRows / viewLength are all injected so
 * we exercise the loop's control flow (length guard, coalescing, event-driven
 * flush, error isolation, stop) deterministically. intervalMs:0 disables the
 * timer so flushes only happen when we call them or emit 'update'.
 */

import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { startHyperbeeReadLoop } from './read-loop'
import type { AutobaseHandle } from './autobase-setup'
import type { HyperbeeOp } from './projections'

function op(id: string): HyperbeeOp {
	return { kind: 'features', id, ts: '2026-05-30T00:00:00Z', schema_version: 1 } as unknown as HyperbeeOp
}

function fakeHandle(base: EventEmitter): AutobaseHandle {
	return { base, view: () => null, append: async () => {}, close: async () => {} } as unknown as AutobaseHandle
}

describe('startHyperbeeReadLoop', () => {
	it('projects all current rows on the initial (forced) pass', async () => {
		const applied: string[] = []
		const rows = [op('F-1'), op('F-2'), op('F-3')]
		const loop = startHyperbeeReadLoop(fakeHandle(new EventEmitter()), {
			workspaceId: 'ws',
			harnessSlug: 'h',
			intervalMs: 0,
			viewLength: () => 3,
			readRows: async () => rows,
			apply: async (o) => { applied.push((o as any).id) },
		})
		// initial flush(true) is fired synchronously inside start; await a tick then force a flush to be deterministic.
		const n = await loop.flush(true)
		expect(n).toBe(3)
		expect(applied).toEqual(['F-1', 'F-2', 'F-3'])
		loop.stop()
	})

	it('skips work when the view length has not advanced (length guard)', async () => {
		const apply = vi.fn(async () => {})
		let len = 5
		const loop = startHyperbeeReadLoop(fakeHandle(new EventEmitter()), {
			workspaceId: 'ws', harnessSlug: 'h', intervalMs: 0,
			viewLength: () => len,
			readRows: async () => [op('F-1')],
			apply,
		})
		await loop.flush(true)        // forced: applies, records appliedAtLen=5
		apply.mockClear()
		const skipped = await loop.flush(false) // same length → no work
		expect(skipped).toBe(0)
		expect(apply).not.toHaveBeenCalled()
		len = 6
		const ran = await loop.flush(false)      // length advanced → applies
		expect(ran).toBe(1)
		expect(apply).toHaveBeenCalledTimes(1)
		loop.stop()
	})

	it('flushes when the Autobase view emits "update"', async () => {
		const base = new EventEmitter()
		const apply = vi.fn(async () => {})
		let len = 1
		const loop = startHyperbeeReadLoop(fakeHandle(base), {
			workspaceId: 'ws', harnessSlug: 'h', intervalMs: 0,
			viewLength: () => len,
			readRows: async () => [op('F-1')],
			apply,
		})
		await loop.flush(true)
		apply.mockClear()
		len = 2
		base.emit('update')
		await new Promise((r) => setTimeout(r, 0)) // let the async flush settle
		expect(apply).toHaveBeenCalledTimes(1)
		loop.stop()
	})

	it('isolates apply errors and keeps projecting the rest', async () => {
		const errors: unknown[] = []
		const applied: string[] = []
		const loop = startHyperbeeReadLoop(fakeHandle(new EventEmitter()), {
			workspaceId: 'ws', harnessSlug: 'h', intervalMs: 0,
			viewLength: () => 1,
			readRows: async () => [op('F-1'), op('F-2'), op('F-3')],
			apply: async (o) => {
				if ((o as any).id === 'F-2') throw new Error('boom')
				applied.push((o as any).id)
			},
			onError: (e) => errors.push(e),
		})
		const n = await loop.flush(true)
		expect(applied).toEqual(['F-1', 'F-3'])
		expect(n).toBe(2)
		expect(errors).toHaveLength(1)
		loop.stop()
	})

	it('stop() prevents further flushes', async () => {
		const apply = vi.fn(async () => {})
		let len = 1
		const loop = startHyperbeeReadLoop(fakeHandle(new EventEmitter()), {
			workspaceId: 'ws', harnessSlug: 'h', intervalMs: 0,
			viewLength: () => len,
			readRows: async () => [op('F-1')],
			apply,
		})
		await loop.flush(true)
		apply.mockClear()
		loop.stop()
		len = 99
		const n = await loop.flush(true)
		expect(n).toBe(0)
		expect(apply).not.toHaveBeenCalled()
	})

	it('coalesces overlapping flushes (one in flight suppresses the next)', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => { release = r })
		let calls = 0
		const loop = startHyperbeeReadLoop(fakeHandle(new EventEmitter()), {
			workspaceId: 'ws', harnessSlug: 'h', intervalMs: 0,
			viewLength: () => 1,
			readRows: async () => { calls++; await gate; return [op('F-1')] },
			apply: async () => {},
		})
		const first = loop.flush(true)         // enters, awaits gate inside readRows
		const second = await loop.flush(true)  // running guard → returns 0 immediately
		expect(second).toBe(0)
		release()
		await first
		expect(calls).toBe(1)
		loop.stop()
	})
})
