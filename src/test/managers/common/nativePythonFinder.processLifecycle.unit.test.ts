import assert from 'node:assert';
import * as sinon from 'sinon';
import { applyPetProcessExit } from '../../../managers/common/nativePythonFinder';

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
