// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import * as rpc from 'vscode-jsonrpc/node';
import {
    backoffThenCheckBudget,
    clampTimeoutToRemaining,
    computeRefreshOperationBudgetMs,
    decideRefreshRetryAction,
    Deadline,
    MIN_STAGE_BUDGET_MS,
    MonotonicClock,
    REFRESH_OPERATION_BUDGET_MS,
    RefreshBudgetExceededError,
    resolveTimeoutForRefresh,
    RpcTimeoutError,
} from '../../../managers/common/nativePythonFinder';

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
    const CONFIGURE_TIMEOUT_MS = 30_000;
    const MAX_CONFIGURE_TIMEOUT_MS = 60_000;
    const REFRESH_TIMEOUT_MS = 30_000;
    const RESOLVE_TIMEOUT_MS = 30_000;
    const RESTART_BACKOFF_BASE_MS = 1_000;
    const MAX_RESTART_ATTEMPTS = 3;
    const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1); // 4s

    test('computeRefreshOperationBudgetMs equals the worst-case successful server path (184s)', () => {
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

suite('Bounded refresh latency — backoffThenCheckBudget (restart recheck)', () => {
    test('resolves without throwing when no deadline is supplied (non-refresh restart path)', async () => {
        let slept = 0;
        await backoffThenCheckBudget(1_000, undefined, async (ms) => {
            slept += ms;
        });
        assert.strictEqual(slept, 1_000, 'the backoff wait still happens');
    });

    test('rejects with RefreshBudgetExceededError when the budget expires during the wait', async () => {
        const { clock, advance } = makeClock();
        const dl = new Deadline(4_000, clock);
        await assert.rejects(
            backoffThenCheckBudget(4_000, dl, async (ms) => {
                advance(ms); // 4s elapses → remaining 0 < floor → exhausted
            }),
            RefreshBudgetExceededError,
        );
    });

    test('resolves when budget remains after the (clamped) backoff', async () => {
        const { clock, advance } = makeClock();
        const dl = new Deadline(100_000, clock);
        await backoffThenCheckBudget(4_000, dl, async (ms) => {
            advance(ms);
        });
        assert.ok(dl.remainingMs() > MIN_STAGE_BUDGET_MS);
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
    });

    test('isExhausted honors a custom floor', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(10_000, clock);

        set(9_500); // remaining 500
        assert.strictEqual(dl.isExhausted(100), false, '500 remaining is above a 100ms floor');
        assert.strictEqual(dl.isExhausted(1_000), true, '500 remaining is below a 1000ms floor');
    });

    test('expiresAt is the fixed absolute instant shared with the queue, independent of the clock', () => {
        const { clock, set } = makeClock(1_000);
        const dl = new Deadline(REFRESH_OPERATION_BUDGET_MS, clock);
        assert.strictEqual(dl.expiresAt, 1_000 + REFRESH_OPERATION_BUDGET_MS);

        set(1_000 + REFRESH_OPERATION_BUDGET_MS);
        assert.strictEqual(dl.remainingMs(), 0);
        assert.strictEqual(dl.expiresAt, 1_000 + REFRESH_OPERATION_BUDGET_MS, 'expiresAt does not move with the clock');
    });
});

suite('Bounded refresh latency — resolveTimeoutForRefresh', () => {
    const RESOLVE_TIMEOUT_MS = 30_000;

    test('returns the base resolve timeout when no deadline is supplied (non-refresh resolve unchanged)', () => {
        assert.strictEqual(resolveTimeoutForRefresh(undefined), RESOLVE_TIMEOUT_MS);
    });

    test('clamps the resolve timeout to the remaining budget', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(80_000); // remaining 20s
        assert.strictEqual(resolveTimeoutForRefresh(dl), 20_000);
    });

    test('preserves the record (undefined) when a late notification arrives below the floor', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(99_500); // remaining 500 < MIN_STAGE_BUDGET_MS → budget spent
        assert.strictEqual(
            resolveTimeoutForRefresh(dl),
            undefined,
            'an exhausted budget must signal preserve-raw, not drop the discovered env',
        );
    });
});

suite('Bounded refresh latency — clampTimeoutToRemaining', () => {
    test('returns the base timeout unchanged when no deadline is supplied (non-refresh callers)', () => {
        assert.strictEqual(clampTimeoutToRemaining(30_000, undefined, 'configure'), 30_000);
        assert.strictEqual(clampTimeoutToRemaining(120_000, undefined, 'cli_find'), 120_000);
    });

    test('returns the base timeout when it is smaller than the remaining budget', () => {
        const { clock } = makeClock();
        const dl = new Deadline(100_000, clock);
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
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'resolve', 100), 500);
        assert.throws(() => clampTimeoutToRemaining(30_000, dl, 'resolve', 1_000), RefreshBudgetExceededError);
    });

    test('propagation across configure → refresh → resolve shrinks the clamp and finally fails fast', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(REFRESH_OPERATION_BUDGET_MS, clock); // 184s

        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'configure'), 30_000);
        set(30_000);

        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 30_000);
        set(60_000);

        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh_resolve'), 30_000);

        set(REFRESH_OPERATION_BUDGET_MS - 20_000);
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 20_000);

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
        assert.strictEqual(err.message, "Refresh operation budget exceeded at stage 'restart' (remaining 250ms)");
    });
});

suite('Bounded refresh latency — decideRefreshRetryAction (terminal telemetry owner)', () => {
    const refreshTimeout = () => new RpcTimeoutError('refresh', 30_000);
    const configureTimeout = () => new RpcTimeoutError('configure', 60_000);
    const connectionError = () => new rpc.ConnectionError(rpc.ConnectionErrors.Closed, 'closed');

    test('retries a retryable failure while budget remains and a retry is left', () => {
        assert.strictEqual(decideRefreshRetryAction(refreshTimeout(), 0, false, false), 'retry');
        assert.strictEqual(decideRefreshRetryAction(connectionError(), 0, false, false), 'retry');
    });

    test('surfaces the original error when the budget is exhausted mid-retry (no new terminal budget error)', () => {
        assert.strictEqual(
            decideRefreshRetryAction(refreshTimeout(), 0, true, false),
            'surface',
            'an exhausted budget must surface the already-reported attempt error so terminal telemetry is emitted once',
        );
        assert.strictEqual(decideRefreshRetryAction(connectionError(), 0, true, false), 'surface');
    });

    test('an exhausted budget mid-retry short-circuits before the server-exhausted CLI fallback', () => {
        assert.strictEqual(decideRefreshRetryAction(refreshTimeout(), 0, true, true), 'surface');
    });

    test('after the final attempt, surfaces when the server is not exhausted and falls back when it is', () => {
        assert.strictEqual(decideRefreshRetryAction(refreshTimeout(), 1, false, false), 'surface');
        assert.strictEqual(decideRefreshRetryAction(refreshTimeout(), 1, false, true), 'fallback');
    });

    test('treats a configure timeout as non-retryable within the refresh loop', () => {
        assert.strictEqual(decideRefreshRetryAction(configureTimeout(), 0, false, false), 'surface');
        assert.strictEqual(decideRefreshRetryAction(configureTimeout(), 0, false, true), 'fallback');
    });

    test('surfaces non-retryable errors, or falls back when the server is exhausted', () => {
        const generic = new Error('boom');
        assert.strictEqual(decideRefreshRetryAction(generic, 0, false, false), 'surface');
        assert.strictEqual(decideRefreshRetryAction(generic, 0, false, true), 'fallback');
    });
});
