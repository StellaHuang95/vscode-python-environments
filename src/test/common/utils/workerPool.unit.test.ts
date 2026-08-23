// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as sinon from 'sinon';
import * as logging from '../../../common/logging';
import { createDeferred, Deferred } from '../../../common/utils/deferred';
import {
    createRunningWorkerPool,
    QueuePosition,
    QueueTaskExpiredError,
    WorkerPool,
} from '../../../common/utils/workerPool';

suite('WorkerPool — pending-task expiration', () => {
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        clock = sinon.useFakeTimers();
        sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
    });

    function makeBlockingPool(): {
        pool: WorkerPool<string, string>;
        started: string[];
        blockerGate: Deferred<string>;
    } {
        const started: string[] = [];
        const blockerGate = createDeferred<string>();
        const pool = createRunningWorkerPool<string, string>(
            async (item: string): Promise<string> => {
                started.push(item);
                if (item === 'blocker') {
                    return blockerGate.promise;
                }
                return item;
            },
            1,
            'test-pool',
        );
        return { pool, started, blockerGate };
    }

    test('queued behind never-resolving work expires and never runs', async () => {
        const { pool, started, blockerGate } = makeBlockingPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);
            assert.deepStrictEqual(started, ['blocker'], 'worker should be busy on blocker');

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            const outcome = pExpire.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );

            await clock.tickAsync(5_000);

            const result = await outcome;
            assert.strictEqual(result.ok, false, 'queued item should have rejected');
            assert.ok(
                !result.ok && result.err instanceof QueueTaskExpiredError,
                'should reject with QueueTaskExpiredError',
            );
            assert.deepStrictEqual(started, ['blocker'], 'expired item must never execute');
        } finally {
            void blockerGate;
            pool.stop();
        }
    });

    test('dequeue clears timer — an immediately dequeued item resolves instead of expiring', async () => {
        const pool = createRunningWorkerPool<string, string>(async (i: string) => i, 1, 'test-pool');
        try {
            const p = pool.addToQueue('quick', QueuePosition.back, 5_000);
            await clock.tickAsync(10_000);
            assert.strictEqual(await p, 'quick', 'dequeued item should resolve normally, not expire');
        } finally {
            pool.stop();
        }
    });

    test('expiry/dequeue boundary — dequeue wins: item runs and a later expiry is a no-op (settles once)', async () => {
        const { pool, started, blockerGate } = makeBlockingPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            let settleCount = 0;
            pExpire.then(
                () => (settleCount += 1),
                () => (settleCount += 1),
            );

            await clock.tickAsync(2_000);
            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            assert.strictEqual(await pExpire, 'expireme', 'dequeued item should resolve with its result');
            assert.ok(started.includes('expireme'), 'item should have executed');

            await clock.tickAsync(10_000);
            assert.strictEqual(settleCount, 1, 'the stale expiry timer must not settle the item a second time');
        } finally {
            pool.stop();
        }
    });

    test('expiry/dequeue boundary — expiry wins: item never runs and stays rejected (settles once)', async () => {
        const { pool, started, blockerGate } = makeBlockingPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            let settleCount = 0;
            let settledErr: unknown;
            pExpire.then(
                () => (settleCount += 1),
                (e: unknown) => {
                    settleCount += 1;
                    settledErr = e;
                },
            );

            await clock.tickAsync(5_000);
            assert.ok(settledErr instanceof QueueTaskExpiredError, 'should reject with QueueTaskExpiredError');

            blockerGate.resolve('blocker');
            await clock.tickAsync(10_000);

            assert.ok(!started.includes('expireme'), 'an expired item must never execute, even after the worker frees up');
            assert.strictEqual(settleCount, 1, 'the item must settle exactly once');
        } finally {
            pool.stop();
        }
    });

    test('stop clears timer — no stale expiry fires after stop, and the item settles once', async () => {
        const { pool, blockerGate } = makeBlockingPool();
        const pBlocker = pool.addToQueue('blocker');
        pBlocker.catch(() => undefined);
        await clock.tickAsync(0);

        const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
        let settleCount = 0;
        let err: unknown;
        pExpire.then(
            () => (settleCount += 1),
            (e: unknown) => {
                settleCount += 1;
                err = e;
            },
        );

        pool.stop();
        await clock.tickAsync(0);

        assert.strictEqual(settleCount, 1, 'stop should settle the queued item once');
        assert.ok(err instanceof Error, 'should reject with an Error');
        assert.ok(!(err instanceof QueueTaskExpiredError), 'stop must not surface an expiry error');

        await clock.tickAsync(10_000);
        assert.strictEqual(settleCount, 1, 'a cleared expiry timer must not fire after stop');
        void blockerGate;
    });

    test('later tasks still run after a queued task expired', async () => {
        const { pool, started, blockerGate } = makeBlockingPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            pExpire.catch(() => undefined);
            await clock.tickAsync(5_000);

            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            const pLater = pool.addToQueue('later');
            assert.strictEqual(await pLater, 'later', 'the pool should keep processing new work after an expiry');
            assert.ok(started.includes('later'), 'later task should have executed');
        } finally {
            pool.stop();
        }
    });

    test('omitting the deadline preserves the original unbounded queueing behavior', async () => {
        const { pool, started, blockerGate } = makeBlockingPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            // No expiresAt → the queued item must never expire.
            const pQueued = pool.addToQueue('patient', QueuePosition.back);
            let settled = false;
            pQueued.then(
                () => (settled = true),
                () => (settled = true),
            );

            await clock.tickAsync(60 * 60 * 1000);
            assert.strictEqual(settled, false, 'a task without a deadline must not expire while queued');
            assert.ok(!started.includes('patient'), 'still queued behind the blocker');

            blockerGate.resolve('blocker');
            await clock.tickAsync(0);
            assert.strictEqual(await pQueued, 'patient', 'it should run once the worker frees up');
        } finally {
            pool.stop();
        }
    });
});

/**
 * Absolute-deadline tests: the pool reads an injected `now` clock, so advancing it past a deadline
 * without firing sinon's faked timer reproduces an event-loop stall and proves the recheck in next().
 */
suite('WorkerPool — absolute-deadline expiration', () => {
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        clock = sinon.useFakeTimers();
        sinon.stub(logging, 'traceError');
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
    });

    function makeInjectedClockPool(): {
        pool: WorkerPool<string, string>;
        started: string[];
        blockerGate: Deferred<string>;
        setNow: (ms: number) => void;
    } {
        const started: string[] = [];
        const blockerGate = createDeferred<string>();
        let nowMs = 0;
        const pool = createRunningWorkerPool<string, string>(
            async (item: string): Promise<string> => {
                started.push(item);
                if (item === 'blocker') {
                    return blockerGate.promise;
                }
                return item;
            },
            1,
            'test-pool',
            () => nowMs,
        );
        return {
            pool,
            started,
            blockerGate,
            setNow: (ms: number) => {
                nowMs = ms;
            },
        };
    }

    test('event-loop stall: absolute recheck expires a queued item even when its timer is delayed', async () => {
        const { pool, started, blockerGate, setNow } = makeInjectedClockPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);
            assert.deepStrictEqual(started, ['blocker']);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            const outcome = pExpire.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );

            // Injected clock jumps past the deadline, but sinon's timer never fires; freeing the worker forces the next() recheck.
            setNow(6_000);
            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            const result = await outcome;
            assert.strictEqual(result.ok, false, 'stalled-past-deadline item must be rejected, not run');
            assert.ok(
                !result.ok && result.err instanceof QueueTaskExpiredError,
                'should reject with QueueTaskExpiredError',
            );
            assert.ok(!started.includes('expireme'), 'expired item must never execute despite a delayed timer');

            setNow(7_000);
            const pLater = pool.addToQueue('later');
            assert.strictEqual(await pLater, 'later', 'the pool keeps processing after an absolute-deadline expiry');
            assert.ok(started.includes('later'));
        } finally {
            pool.stop();
        }
    });

    test('boundary: an item whose deadline exactly equals now expires (>=) and does not run', async () => {
        const { pool, started, blockerGate, setNow } = makeInjectedClockPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000); // expiresAt = 5000, injected clock
            const outcome = pExpire.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );

            setNow(5_000); // exactly at the deadline → recheck expires it (>=)
            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            const result = await outcome;
            assert.strictEqual(result.ok, false, 'an item exactly at its deadline must expire (>= boundary)');
            assert.ok(!result.ok && result.err instanceof QueueTaskExpiredError);
            assert.ok(!started.includes('expireme'));
        } finally {
            pool.stop();
        }
    });

    test('expiresAt is the caller-supplied absolute instant, not a budget recaptured at enqueue', async () => {
        const { pool, started, blockerGate, setNow } = makeInjectedClockPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            setNow(3_000);
            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            const outcome = pExpire.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );

            setNow(5_000);
            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            const result = await outcome;
            assert.strictEqual(result.ok, false, 'the absolute deadline (5000) must expire at now=5000');
            assert.ok(!result.ok && result.err instanceof QueueTaskExpiredError);
            assert.ok(!started.includes('expireme'), 'a past-deadline item must never execute');
        } finally {
            pool.stop();
        }
    });

    test('next() skips a stalled-expired item and continues to the next valid queued item', async () => {
        const { pool, started, blockerGate, setNow } = makeInjectedClockPool();
        try {
            const pBlocker = pool.addToQueue('blocker');
            pBlocker.catch(() => undefined);
            await clock.tickAsync(0);

            const pExpire = pool.addToQueue('expireme', QueuePosition.back, 5_000);
            const expireOutcome = pExpire.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );
            const pKeep = pool.addToQueue('keepme', QueuePosition.back);

            setNow(6_000);
            blockerGate.resolve('blocker');
            await clock.tickAsync(0);

            const result = await expireOutcome;
            assert.strictEqual(result.ok, false, 'the stalled item should be expired');
            assert.ok(!result.ok && result.err instanceof QueueTaskExpiredError);
            assert.strictEqual(await pKeep, 'keepme', 'next() must continue to the next valid item after skipping an expired one');
            assert.ok(!started.includes('expireme'), 'expired item never ran');
            assert.ok(started.includes('keepme'), 'the following valid item ran');
        } finally {
            pool.stop();
        }
    });

    test('enqueuing an already-expired item (deadline at or before now) rejects it without stranding the parked worker', async () => {
        const started: string[] = [];
        const pool = createRunningWorkerPool<string, string>(
            async (i: string) => {
                started.push(i);
                return i;
            },
            1,
            'test-pool',
        );
        try {
            const pExpired = pool.addToQueue('expired-now', QueuePosition.back, 0);
            const outcome = pExpired.then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e }),
            );
            await clock.tickAsync(0);

            const result = await outcome;
            assert.strictEqual(result.ok, false, 'a non-positive expiry must reject immediately');
            assert.ok(!result.ok && result.err instanceof QueueTaskExpiredError);
            assert.ok(!started.includes('expired-now'), 'the already-expired item never ran');

            const pLater = pool.addToQueue('later');
            assert.strictEqual(await pLater, 'later', 'worker was re-parked and still processes new work');
            assert.ok(started.includes('later'));
        } finally {
            pool.stop();
        }
    });
});
