// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import {
    clampTimeoutToRemaining,
    computeRefreshOperationBudgetMs,
    Deadline,
    MIN_STAGE_BUDGET_MS,
    MonotonicClock,
    REFRESH_OPERATION_BUDGET_MS,
    RefreshBudgetExceededError,
} from '../../../managers/common/nativePythonFinder';

// A small mutable monotonic clock so all deadline math is deterministic (no wall-clock/perf.now()).
function makeClock(start = 0): { clock: MonotonicClock; advance(ms: number): void; set(ms: number): void } {
    let t = start;
    return {
        clock: () => t,
        advance: (ms: number) => {
            t += ms;
        },
        set: (ms: number) => {
            t = ms;
        },
    };
}

suite('Bounded refresh latency — operation budget', () => {
    // Constants the formula is derived from (kept in sync with nativePythonFinder.ts).
    const CONFIGURE_TIMEOUT_MS = 30_000;
    const MAX_CONFIGURE_TIMEOUT_MS = 60_000;
    const REFRESH_TIMEOUT_MS = 30_000;
    const RESOLVE_TIMEOUT_MS = 30_000;
    const RESTART_BACKOFF_BASE_MS = 1_000;
    const MAX_RESTART_ATTEMPTS = 3;

    test('computeRefreshOperationBudgetMs equals the attained worst-case successful path (184s)', () => {
        const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1); // 4s
        const failingAttemptMs = MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS; // 60 + 30 = 90s
        const succeedingAttemptMs =
            maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS + RESOLVE_TIMEOUT_MS; // 4 + 30 + 30 + 30 = 94s
        const expected = failingAttemptMs + succeedingAttemptMs; // 184s

        assert.strictEqual(expected, 184_000, 'sanity: hand arithmetic should be 184000ms');
        assert.strictEqual(computeRefreshOperationBudgetMs(), 184_000);
        assert.strictEqual(REFRESH_OPERATION_BUDGET_MS, 184_000);
    });

    test('MIN_STAGE_BUDGET_MS floor is 1s', () => {
        assert.strictEqual(MIN_STAGE_BUDGET_MS, 1_000);
    });
});

suite('Bounded refresh latency — Deadline', () => {
    test('remainingMs counts down as the monotonic clock advances', () => {
        const { clock, advance } = makeClock();
        const dl = new Deadline(10_000, clock);
        assert.strictEqual(dl.remainingMs(), 10_000);

        advance(4_000);
        assert.strictEqual(dl.remainingMs(), 6_000);

        advance(6_000);
        assert.strictEqual(dl.remainingMs(), 0);

        advance(1_000); // past the deadline
        assert.strictEqual(dl.remainingMs(), -1_000);
    });

    test('isExhausted uses the default floor (MIN_STAGE_BUDGET_MS) when none is given', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(10_000, clock);

        set(8_999); // remaining 1001 > floor 1000
        assert.strictEqual(dl.isExhausted(), false);

        set(9_000); // remaining 1000 == floor → NOT exhausted (strictly-less check)
        assert.strictEqual(dl.isExhausted(), false);

        set(9_001); // remaining 999 < floor
        assert.strictEqual(dl.isExhausted(), true);

        set(9_500); // remaining 500 < floor
        assert.strictEqual(dl.isExhausted(), true);
    });

    test('isExhausted honors a custom floor', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(10_000, clock);

        set(9_500); // remaining 500
        assert.strictEqual(dl.isExhausted(100), false, '500 remaining is above a 100ms floor');
        assert.strictEqual(dl.isExhausted(1_000), true, '500 remaining is below a 1000ms floor');
    });
});

suite('Bounded refresh latency — clampTimeoutToRemaining', () => {
    test('returns the base timeout unchanged when no deadline is supplied (resolve/non-refresh callers)', () => {
        assert.strictEqual(clampTimeoutToRemaining(30_000, undefined, 'configure'), 30_000);
        assert.strictEqual(clampTimeoutToRemaining(120_000, undefined, 'cli_find'), 120_000);
    });

    test('returns the base timeout when it is smaller than the remaining budget', () => {
        const { clock } = makeClock();
        const dl = new Deadline(100_000, clock); // remaining 100s
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 30_000);
    });

    test('clamps down to the remaining budget when less than the base timeout remains', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(80_000); // remaining 20s
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 20_000);
    });

    test('throws RefreshBudgetExceededError when the remaining budget is below the floor', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(99_500); // remaining 500 < 1000 floor
        assert.throws(() => clampTimeoutToRemaining(30_000, dl, 'resolve'), RefreshBudgetExceededError);
    });

    test('honors a custom floor', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(99_500); // remaining 500
        // Above a 100ms floor: clamps to remaining rather than throwing.
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'resolve', 100), 500);
        // Below a 1000ms floor: throws.
        assert.throws(() => clampTimeoutToRemaining(30_000, dl, 'resolve', 1_000), RefreshBudgetExceededError);
    });

    test('propagation across configure → refresh → resolve shrinks the clamp and finally fails fast', () => {
        // Mirrors how doRefreshAttempt threads one Deadline through its stages. We drive an injected
        // clock forward by however long each stage "took" and check what timeout the next stage gets.
        const { clock, set } = makeClock();
        const dl = new Deadline(REFRESH_OPERATION_BUDGET_MS, clock); // 184s

        // configure gets its full base timeout while lots of budget remains.
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'configure'), 30_000);
        set(30_000); // configure consumed 30s

        // refresh still fits.
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 30_000);
        set(60_000); // refresh consumed 30s

        // resolve still fits (124s remaining).
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh_resolve'), 30_000);

        // Late in the operation only 20s remain → the next stage is clamped down.
        set(REFRESH_OPERATION_BUDGET_MS - 20_000);
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 20_000);

        // Almost no budget left → fail fast instead of starting a doomed stage.
        set(REFRESH_OPERATION_BUDGET_MS - 100);
        assert.throws(() => clampTimeoutToRemaining(30_000, dl, 'refresh'), RefreshBudgetExceededError);
    });
});

suite('Bounded refresh latency — RefreshBudgetExceededError', () => {
    test('carries the stage and has a stable name', () => {
        const err = new RefreshBudgetExceededError('restart', 250);
        assert.strictEqual(err.name, 'RefreshBudgetExceededError');
        assert.strictEqual(err.stage, 'restart');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof RefreshBudgetExceededError);
        assert.match(err.message, /restart/);
        assert.match(err.message, /budget exceeded/i);
    });
});
