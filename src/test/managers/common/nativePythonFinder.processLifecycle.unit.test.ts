import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import { applyPetProcessExit, registerPetProcessLifecycleHandlers } from '../../../managers/common/nativePythonFinder';

/**
 * Regression tests for the PET process-lifecycle ownership guard.
 *
 * The exit/error handlers registered in `start()` are never unregistered on restart, so a late
 * event from a captured *old* child can fire after `restart()` has already installed a healthy
 * replacement. Previously those handlers unconditionally set `this.processExited = true`, which
 * `ensureProcessRunning()` reads to decide whether to restart — so a stale exit forced a spurious
 * restart that killed the healthy replacement. `applyPetProcessExit` guards the shared-state
 * mutation by process identity so a superseded child's event is ignored.
 */
suite('applyPetProcessExit (PET lifecycle ownership guard)', () => {
    teardown(() => {
        sinon.restore();
    });

    type FakeProc = { exitCode: number | null; kill: sinon.SinonStub };

    function makeProc(exitCode: number | null): FakeProc {
        return { exitCode, kill: sinon.stub().returns(true) };
    }

    test("old child's late exit after replacement startup is ignored; replacement stays healthy", () => {
        // A restart has installed a healthy replacement as the active child.
        const oldChild = makeProc(0); // old child already terminated (e.g. via SIGKILL)
        const replacement = makeProc(null); // healthy replacement, currently active
        const state: { processExited: boolean; processExitReason: string | undefined } = {
            processExited: false,
            processExitReason: undefined,
        };

        // The old child's exit event fires LATE, after the replacement is active.
        const applied = applyPetProcessExit(replacement, oldChild, () => {
            state.processExited = true;
            state.processExitReason = 'process_exit:0:none';
        });

        assert.strictEqual(applied, false, 'stale exit from a superseded child must be ignored');
        // processExited is exactly the flag ensureProcessRunning() checks, so keeping it false
        // means no spurious restart (and therefore no kill of the healthy replacement).
        assert.strictEqual(state.processExited, false, 'replacement stays healthy; no extra restart is triggered');
        assert.strictEqual(state.processExitReason, undefined, 'no exit reason recorded for a stale event');
    });

    test('exit of the currently-active child is recorded so the next request fails fast', () => {
        const active = makeProc(null);
        const state: { processExited: boolean; processExitReason: string | undefined } = {
            processExited: false,
            processExitReason: undefined,
        };

        const applied = applyPetProcessExit(active, active, () => {
            state.processExited = true;
            if (state.processExitReason === undefined) {
                state.processExitReason = 'process_exit:1:none';
            }
        });

        assert.strictEqual(applied, true, 'event from the active child applies');
        assert.strictEqual(state.processExited, true);
        assert.strictEqual(state.processExitReason, 'process_exit:1:none');
    });

    test('event is ignored while no process is active (kill/restart window)', () => {
        const oldChild = makeProc(0);
        const markExited = sinon.stub();

        const applied = applyPetProcessExit(undefined, oldChild, markExited);

        assert.strictEqual(applied, false);
        assert.ok(markExited.notCalled, 'no shared-state mutation when there is no active process');
    });

    test('invokes markExited exactly once when the event applies', () => {
        const active = makeProc(null);
        const markExited = sinon.stub();

        applyPetProcessExit(active, active, markExited);

        assert.strictEqual(markExited.callCount, 1);
    });

    test('a superseded child cannot overwrite the active child state across a restart sequence', () => {
        const state: { proc: FakeProc | undefined; processExited: boolean } = {
            proc: undefined,
            processExited: false,
        };
        const markExited = () => {
            state.processExited = true;
        };

        // gen1 is active and crashes -> recorded, triggering a restart on the next request.
        const gen1 = makeProc(null);
        state.proc = gen1;
        assert.strictEqual(
            applyPetProcessExit(state.proc, gen1, markExited),
            true,
            'active gen1 crash is recorded',
        );
        assert.strictEqual(state.processExited, true);

        // Restart clears state and installs a healthy gen2 replacement.
        state.processExited = false;
        gen1.exitCode = 137; // gen1 finally terminated
        const gen2 = makeProc(null);
        state.proc = gen2;

        // gen1's delayed exit now fires again -> must NOT touch the healthy gen2.
        assert.strictEqual(
            applyPetProcessExit(state.proc, gen1, markExited),
            false,
            'gen1 late exit is ignored once gen2 is active',
        );
        assert.strictEqual(state.processExited, false, 'gen2 remains healthy; no extra restart occurs');
    });
});

/**
 * Regression tests for the production wiring that `start()` installs. These exercise the exact
 * exit/error handlers registered on the child (via a real `EventEmitter`), proving the handlers are
 * attached, identity-guarded, reason-preserving, and log the way production expects — coverage the
 * `applyPetProcessExit`-only tests above cannot provide because they bypass the registration.
 */
suite('registerPetProcessLifecycleHandlers (PET lifecycle wiring)', () => {
    teardown(() => {
        sinon.restore();
    });

    type LifecycleState = { processExited: boolean; processExitReason: string | undefined };

    function makeState(): LifecycleState {
        return { processExited: false, processExitReason: undefined };
    }

    // Mirrors the production markExited closure: marks exited and keeps the first (most-specific) reason.
    function markExitedInto(state: LifecycleState): (reason: string) => void {
        return (reason) => {
            state.processExited = true;
            if (state.processExitReason === undefined) {
                state.processExitReason = reason;
            }
        };
    }

    test("wires the active child's exit into restart state and logs an unexpected exit", () => {
        const active = new EventEmitter();
        const state = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(active, () => active, markExitedInto(state), outputChannel);
        active.emit('exit', 1, null);

        assert.strictEqual(state.processExited, true, 'active child exit marks the finder as exited');
        assert.strictEqual(state.processExitReason, 'process_exit:1:none');
        assert.ok(
            outputChannel.error.calledOnceWith(
                '[pet] Python Environment Tools exited unexpectedly with code 1, signal null',
            ),
            'a non-zero exit is surfaced',
        );
    });

    test('a clean exit (code 0) of the active child is recorded without an error log', () => {
        const active = new EventEmitter();
        const state = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(active, () => active, markExitedInto(state), outputChannel);
        active.emit('exit', 0, null);

        assert.strictEqual(state.processExited, true);
        assert.strictEqual(state.processExitReason, 'process_exit:0:none');
        assert.ok(outputChannel.error.notCalled, 'a clean exit is not logged as unexpected');
    });

    test('a signal-terminated active child (code null) records signal in the reason and is logged', () => {
        const active = new EventEmitter();
        const state = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(active, () => active, markExitedInto(state), outputChannel);
        // POSIX signal termination: exit fires with a null code and a signal name.
        active.emit('exit', null, 'SIGTERM');

        assert.strictEqual(state.processExited, true);
        assert.strictEqual(state.processExitReason, 'process_exit:null:SIGTERM', 'null code and signal are recorded');
        assert.ok(
            outputChannel.error.calledOnceWith(
                '[pet] Python Environment Tools exited unexpectedly with code null, signal SIGTERM',
            ),
            'a null-code (signalled) exit is surfaced',
        );
    });

    test("wires the active child's error into restart state and logs it", () => {
        const active = new EventEmitter();
        const state = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(active, () => active, markExitedInto(state), outputChannel);
        const err = new Error('ENOENT');
        active.emit('error', err);

        assert.strictEqual(state.processExited, true);
        assert.strictEqual(state.processExitReason, 'process_error');
        assert.ok(outputChannel.error.calledOnceWith('[pet] Process error:', err));
    });

    test('exit then error on the active child is idempotent and preserves the first reason', () => {
        const active = new EventEmitter();
        const state = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(active, () => active, markExitedInto(state), outputChannel);
        active.emit('exit', 2, null);
        active.emit('error', new Error('late error'));

        assert.strictEqual(state.processExited, true);
        assert.strictEqual(
            state.processExitReason,
            'process_exit:2:none',
            'the first, most-specific reason is preserved across later events',
        );
    });

    test("a superseded child's late exit does not touch the healthy replacement's state", () => {
        const oldChild = new EventEmitter();
        const replacement = new EventEmitter();
        const oldState = makeState();
        const replacementState = makeState();
        const outputChannel = { error: sinon.stub() };

        // Both children have handlers registered, but `replacement` is the finder's active child now.
        registerPetProcessLifecycleHandlers(oldChild, () => replacement, markExitedInto(oldState), outputChannel);
        registerPetProcessLifecycleHandlers(
            replacement,
            () => replacement,
            markExitedInto(replacementState),
            outputChannel,
        );

        // The superseded old child finally exits (non-zero, e.g. from the SIGKILL during restart).
        oldChild.emit('exit', 137, 'SIGKILL');

        assert.strictEqual(oldState.processExited, false, 'stale exit is ignored by the identity guard');
        assert.strictEqual(
            replacementState.processExited,
            false,
            'the healthy replacement is untouched, so no spurious restart is triggered',
        );
        // The diagnostic is still surfaced (pre-existing behaviour), but no shared state changed.
        assert.ok(
            outputChannel.error.calledOnceWith(
                '[pet] Python Environment Tools exited unexpectedly with code 137, signal SIGKILL',
            ),
        );
    });

    test("a superseded child's late error does not touch the healthy replacement's state", () => {
        const oldChild = new EventEmitter();
        const replacement = new EventEmitter();
        const oldState = makeState();
        const outputChannel = { error: sinon.stub() };

        registerPetProcessLifecycleHandlers(oldChild, () => replacement, markExitedInto(oldState), outputChannel);
        oldChild.emit('error', new Error('stale error'));

        assert.strictEqual(oldState.processExited, false, 'stale error is ignored by the identity guard');
        assert.ok(outputChannel.error.calledOnce, 'the error is still logged as a diagnostic');
    });
});
