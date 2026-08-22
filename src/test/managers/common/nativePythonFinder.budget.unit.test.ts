// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import {
    backoffThenCheckBudget,
    clampTimeoutToRemaining,
    computeCliFallbackPathBudgetMs,
    computeRefreshOperationBudgetMs,
    computeServerRefreshBudgetMs,
    Deadline,
    decideRefreshRetry,
    MIN_STAGE_BUDGET_MS,
    MonotonicClock,
    REFRESH_OPERATION_BUDGET_MS,
    RefreshBudgetExceededError,
    retryWouldStarveCliFallbackMs,
    RpcTimeoutError,
    toBudgetError,
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
    const CLI_FALLBACK_TIMEOUT_MS = 120_000;
    const RESTART_BACKOFF_BASE_MS = 1_000;
    const MAX_RESTART_ATTEMPTS = 3;
    const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1); // 4s

    test('computeServerRefreshBudgetMs equals the attained worst-case successful server path (184s)', () => {
        const failingAttemptMs = MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS; // 60 + 30 = 90s
        const succeedingAttemptMs =
            maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS + RESOLVE_TIMEOUT_MS; // 4 + 30 + 30 + 30 = 94s
        const expected = failingAttemptMs + succeedingAttemptMs; // 184s

        assert.strictEqual(expected, 184_000, 'sanity: hand arithmetic should be 184000ms');
        assert.strictEqual(computeServerRefreshBudgetMs(), 184_000);
    });

    test('computeCliFallbackPathBudgetMs reserves one worst server attempt + transition + full CLI scan (214s)', () => {
        const worstServerAttemptMs = MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS; // 90s
        const expected = worstServerAttemptMs + maxRestartBackoffMs + CLI_FALLBACK_TIMEOUT_MS; // 90 + 4 + 120 = 214s

        assert.strictEqual(expected, 214_000, 'sanity: hand arithmetic should be 214000ms');
        assert.strictEqual(computeCliFallbackPathBudgetMs(), 214_000);
    });

    test('computeRefreshOperationBudgetMs is the max of the server and CLI-fallback paths (214s)', () => {
        assert.strictEqual(
            computeRefreshOperationBudgetMs(),
            Math.max(computeServerRefreshBudgetMs(), computeCliFallbackPathBudgetMs()),
        );
        assert.strictEqual(computeRefreshOperationBudgetMs(), 214_000);
        assert.strictEqual(REFRESH_OPERATION_BUDGET_MS, 214_000);
    });

    test('the operation budget is bounded — not an arbitrary stack of every pathological timeout', () => {
        // It must never exceed the larger of the two reachable successful paths.
        assert.ok(REFRESH_OPERATION_BUDGET_MS <= 214_000, 'budget should not exceed the CLI-fallback path');
        // And it must be large enough to fund a full CLI enumeration reserve.
        assert.ok(REFRESH_OPERATION_BUDGET_MS >= CLI_FALLBACK_TIMEOUT_MS, 'budget must cover a full CLI scan');
    });

    test('MIN_STAGE_BUDGET_MS floor is 1s', () => {
        assert.strictEqual(MIN_STAGE_BUDGET_MS, 1_000);
    });
});

suite('Bounded refresh latency — retryWouldStarveCliFallbackMs', () => {
    const CONFIGURE_TIMEOUT_MS = 30_000;
    const REFRESH_TIMEOUT_MS = 30_000;
    const CLI_FALLBACK_TIMEOUT_MS = 120_000;
    const MIN_STAGE_BUDGET = 1_000;
    const maxRestartBackoffMs = 4_000;
    // worstRetryCost (4 + 30 + 30 = 64s) + cliReserve (120 + 1 = 121s) = 185s threshold.
    const threshold = maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS + CLI_FALLBACK_TIMEOUT_MS + MIN_STAGE_BUDGET;

    test('threshold is 185s from the existing constants', () => {
        assert.strictEqual(threshold, 185_000);
    });

    test('returns true when a retry would leave less than a full CLI enumeration reserve', () => {
        assert.strictEqual(retryWouldStarveCliFallbackMs(threshold - 1), true);
        assert.strictEqual(retryWouldStarveCliFallbackMs(124_000), true, 'after a 90s server attempt, skip to CLI');
    });

    test('returns false when there is ample budget for both another server attempt and the CLI reserve', () => {
        assert.strictEqual(retryWouldStarveCliFallbackMs(threshold), false);
        assert.strictEqual(retryWouldStarveCliFallbackMs(212_000), false, 'a fast early failure still allows a retry');
    });

    test('a valid 60s CLI scan remains fundable after a server failure while total latency stays bounded', () => {
        // Worst realistic entry to the CLI fallback: a full failing server attempt consumed 90s of a
        // fresh 214s budget, leaving 124s. The retry guard trips (124 < 185) so we skip straight to CLI.
        const remainingAfterServerFailure = REFRESH_OPERATION_BUDGET_MS - (60_000 + 30_000); // 124s
        assert.strictEqual(retryWouldStarveCliFallbackMs(remainingAfterServerFailure), true, 'must skip the retry');

        // The CLI scan is clamped to the remaining budget; a 60s scan easily fits under the ~124s left,
        // and the whole operation is still bounded by REFRESH_OPERATION_BUDGET_MS.
        const { clock } = makeClock();
        const dl = new Deadline(remainingAfterServerFailure, clock);
        const cliScanTimeout = clampTimeoutToRemaining(CLI_FALLBACK_TIMEOUT_MS, dl, 'cli_find');
        assert.ok(cliScanTimeout >= 60_000, 'a 60s CLI scan must be allowed after a server failure');
        assert.ok(
            60_000 + (90_000) <= REFRESH_OPERATION_BUDGET_MS,
            'server failure (90s) + a 60s CLI scan stays within the operation budget',
        );
    });
});

suite('Bounded refresh latency — toBudgetError (deadline provenance)', () => {
    test('returns undefined when there is no deadline (non-refresh callers stay unchanged)', () => {
        const err = new RpcTimeoutError('configure', 30_000);
        assert.strictEqual(toBudgetError(err, undefined, 'configure', false), undefined);
    });

    test('returns undefined for an unclamped base-timeout stage while the budget is healthy (slow PET)', () => {
        const { clock } = makeClock();
        const dl = new Deadline(100_000, clock); // full budget remaining → stage ran on its base timeout
        const err = new RpcTimeoutError('refresh', 30_000);
        assert.strictEqual(toBudgetError(err, dl, 'refresh', false), undefined);
    });

    test('does NOT reclassify an unclamped base-timeout stage even when the deadline is now exhausted', () => {
        // Regression: a 30s base timeout that started with 30.5s remaining is NOT deadline-clamped
        // (min(30000, 30500) = 30000 = base). Its timing out is genuine PET slowness and must keep
        // normal stage-timeout telemetry / retry / recovery — not be misattributed to the budget cap.
        const { clock, set } = makeClock();
        const dl = new Deadline(30_500, clock);
        set(30_000); // 30s base timeout elapsed → remaining 500 < floor → deadline.isExhausted() is now true
        assert.strictEqual(dl.isExhausted(), true, 'guard: the deadline is exhausted post-timeout');
        const err = new RpcTimeoutError('refresh', 30_000);
        assert.strictEqual(
            toBudgetError(err, dl, 'refresh', false),
            undefined,
            'an unclamped full base-timeout that merely ends with <floor budget is not a budget cap',
        );
    });

    test('reclassifies a deadline-clamped RpcTimeoutError as a budget error', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(99_900); // remaining 100 < floor → exhausted
        const err = new RpcTimeoutError('configure', 100);
        const budget = toBudgetError(err, dl, 'configure', true);
        assert.ok(budget instanceof RefreshBudgetExceededError, 'a clamped timeout is a budget error');
        assert.strictEqual(budget?.stage, 'configure');
    });

    test('does not reclassify a non-timeout error even when the stage was deadline-clamped', () => {
        const { clock, set } = makeClock();
        const dl = new Deadline(100_000, clock);
        set(99_900);
        assert.strictEqual(toBudgetError(new Error('boom'), dl, 'refresh', true), undefined);
    });
});

suite('Bounded refresh latency — backoffThenCheckBudget (restart recheck)', () => {
    test('resolves without throwing when no deadline is supplied (resolve/non-refresh restart path)', async () => {
        let slept = 0;
        await backoffThenCheckBudget(1_000, undefined, async (ms) => {
            slept += ms;
        });
        assert.strictEqual(slept, 1_000, 'the backoff wait still happens');
    });

    test('rejects with RefreshBudgetExceededError when the budget expires during the wait', async () => {
        const { clock, advance } = makeClock();
        const dl = new Deadline(4_000, clock); // 4s budget
        // The injected sleep advances the clock past the deadline, mimicking a backoff that outlasts it.
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
            advance(ms); // only 4s of a 100s budget consumed
        });
        // No throw → restart may proceed to teardown/spawn.
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
        const dl = new Deadline(REFRESH_OPERATION_BUDGET_MS, clock); // 214s

        // configure gets its full base timeout while lots of budget remains.
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'configure'), 30_000);
        set(30_000); // configure consumed 30s

        // refresh still fits.
        assert.strictEqual(clampTimeoutToRemaining(30_000, dl, 'refresh'), 30_000);
        set(60_000); // refresh consumed 30s

        // resolve still fits (154s remaining of the 214s budget).
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
        assert.strictEqual(
            err.message,
            "Refresh operation budget exceeded at stage 'restart' (remaining 250ms)",
        );
    });
});

suite('Bounded refresh latency — decideRefreshRetry (composed retry/CLI-fallback decision)', () => {
    const MAX_REFRESH_RETRIES = 1;
    // Remaining budget after a full 90s failing first server attempt on a fresh 214s budget.
    const AFTER_ONE_SERVER_FAILURE = REFRESH_OPERATION_BUDGET_MS - 90_000; // 124_000
    // Ample budget after a fast crash (well above the 185s starvation threshold).
    const AMPLE = 212_000;

    test('a budget error stops immediately: never retry, never fall back', () => {
        const decision = decideRefreshRetry({
            isBudgetError: true,
            isRetryable: true,
            attempt: 0,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: AMPLE,
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'rethrow' });
    });

    test('a retryable failure with ample budget retries another server attempt', () => {
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: 0,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: AMPLE,
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'retry' });
    });

    test('REGRESSION: a retryable failure that would starve the CLI budget falls back to the CLI, not a retry', () => {
        // This is exactly the server-exhaustion → CLI-fallback path that the earlier 184s budget bug
        // got wrong: after a 90s server failure (124s left < 185s threshold), another server attempt
        // would consume the reserved CLI enumeration budget, so we must skip straight to the CLI.
        assert.strictEqual(retryWouldStarveCliFallbackMs(AFTER_ONE_SERVER_FAILURE), true);
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: 0,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: AFTER_ONE_SERVER_FAILURE,
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'cli-fallback', reason: 'starvation' });
    });

    test('a retryable failure with budget below one stage floor surfaces a budget error', () => {
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: 0,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: MIN_STAGE_BUDGET_MS - 1, // below the floor → exhausted
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'budget-exceeded' });
    });

    test('the final retryable attempt falls back to the CLI once server mode is exhausted', () => {
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: MAX_REFRESH_RETRIES, // no retries left
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: AMPLE,
            serverExhausted: true,
        });
        assert.deepStrictEqual(decision, { kind: 'cli-fallback', reason: 'server-exhausted' });
    });

    test('the final attempt rethrows when server mode is not exhausted', () => {
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: MAX_REFRESH_RETRIES,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: AMPLE,
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'rethrow' });
    });

    test('a non-retryable error falls back to the CLI iff server mode is exhausted, else rethrows', () => {
        assert.deepStrictEqual(
            decideRefreshRetry({
                isBudgetError: false,
                isRetryable: false,
                attempt: 0,
                maxRetries: MAX_REFRESH_RETRIES,
                remainingMs: AMPLE,
                serverExhausted: true,
            }),
            { kind: 'cli-fallback', reason: 'server-exhausted' },
        );
        assert.deepStrictEqual(
            decideRefreshRetry({
                isBudgetError: false,
                isRetryable: false,
                attempt: 0,
                maxRetries: MAX_REFRESH_RETRIES,
                remainingMs: AMPLE,
                serverExhausted: false,
            }),
            { kind: 'rethrow' },
        );
    });

    test('with no deadline (non-refresh path) a retryable mid-attempt failure always retries', () => {
        // remainingMs === undefined: no budget-exceeded and no starvation fallback can fire, preserving
        // the unbounded resolve/non-refresh behavior.
        const decision = decideRefreshRetry({
            isBudgetError: false,
            isRetryable: true,
            attempt: 0,
            maxRetries: MAX_REFRESH_RETRIES,
            remainingMs: undefined,
            serverExhausted: false,
        });
        assert.deepStrictEqual(decision, { kind: 'retry' });
    });
});
