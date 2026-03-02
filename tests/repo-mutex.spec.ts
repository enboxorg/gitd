/**
 * Tests for the per-repo mutex (`withRepoLock`).
 */
import { describe, expect, it } from 'bun:test';

import { withRepoLock } from '../src/git-server/repo-mutex.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a promise that can be resolved externally. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withRepoLock', () => {
  it('returns the value produced by fn', async () => {
    const result = await withRepoLock('test/return', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes operations on the same key', async () => {
    const order: number[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    // First operation: starts immediately, waits on gate1.
    const op1 = withRepoLock('test/serial', async () => {
      order.push(1);
      await gate1.promise;
      order.push(2);
      return 'a';
    });

    // Second operation: queued behind op1, waits on gate2.
    const op2 = withRepoLock('test/serial', async () => {
      order.push(3);
      await gate2.promise;
      order.push(4);
      return 'b';
    });

    // op1 should have started (pushed 1), op2 should not yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);

    // Release op1 — it finishes, then op2 starts.
    gate1.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1, 2, 3]);

    // Release op2.
    gate2.resolve();
    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('runs operations on different keys concurrently', async () => {
    const order: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const opA = withRepoLock('test/key-a', async () => {
      order.push('a-start');
      await gateA.promise;
      order.push('a-end');
    });

    const opB = withRepoLock('test/key-b', async () => {
      order.push('b-start');
      await gateB.promise;
      order.push('b-end');
    });

    // Both should have started concurrently.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toContain('a-start');
    expect(order).toContain('b-start');
    expect(order).toHaveLength(2);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([opA, opB]);
    expect(order).toHaveLength(4);
  });

  it('propagates errors from fn', async () => {
    await expect(
      withRepoLock('test/error', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('releases the lock even when fn throws', async () => {
    // First call throws.
    await withRepoLock('test/recovery', async () => {
      throw new Error('fail');
    }).catch(() => { /* expected */ });

    // Second call should still run (not deadlock).
    const result = await withRepoLock('test/recovery', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('queues three operations in order', async () => {
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const ops = gates.map((gate, i) =>
      withRepoLock('test/triple', async () => {
        order.push(i);
        await gate.promise;
      }),
    );

    // Only the first should have started.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0]);

    // Release first — second starts.
    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1]);

    // Release second — third starts.
    gates[1].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1, 2]);

    gates[2].resolve();
    await Promise.all(ops);
    expect(order).toEqual([0, 1, 2]);
  });
});
