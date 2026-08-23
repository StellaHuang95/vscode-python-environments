import assert from 'node:assert';
import * as sinon from 'sinon';
import { killPetProcessWithGrace } from '../../../managers/common/nativePythonFinder';

suite('killPetProcessWithGrace (PET force-kill ownership)', () => {
    const GRACE_MS = 500;

    let clock: sinon.SinonFakeTimers;
    let outputChannel: { info: sinon.SinonStub; error: sinon.SinonStub };

    setup(() => {
        clock = sinon.useFakeTimers();
        outputChannel = { info: sinon.stub(), error: sinon.stub() };
    });

    teardown(() => {
        clock.restore();
        sinon.restore();
    });

    function makeProc(exitCode: number | null = null): { exitCode: number | null; kill: sinon.SinonStub } {
        return { exitCode, kill: sinon.stub().returns(true) };
    }

    test('sends SIGTERM to the running child and relinquishes ownership synchronously', () => {
        const original = makeProc(null);
        let holder: typeof original | undefined = original;

        killPetProcessWithGrace(
            () => holder,
            () => {
                holder = undefined;
            },
            outputChannel,
        );

        assert.strictEqual(holder, undefined, 'ownership should be relinquished before any async work');
        assert.ok(original.kill.calledOnceWithExactly('SIGTERM'), 'original should receive exactly one SIGTERM');
        assert.ok(outputChannel.info.called, 'kill should be logged');
    });

    test('escalates to SIGKILL on the captured child after the grace period', () => {
        const original = makeProc(null);
        let holder: typeof original | undefined = original;

        killPetProcessWithGrace(
            () => holder,
            () => {
                holder = undefined;
            },
            outputChannel,
        );

        assert.ok(original.kill.calledWith('SIGTERM'), 'SIGTERM sent immediately');
        assert.ok(!original.kill.calledWith('SIGKILL'), 'SIGKILL not sent before grace elapses');

        clock.tick(GRACE_MS);

        assert.ok(original.kill.calledWith('SIGKILL'), 'SIGKILL sent after grace period');
        assert.strictEqual(original.kill.callCount, 2, 'exactly SIGTERM then SIGKILL');
    });

    test('does not force-kill a child that exits during the grace period', () => {
        const original = makeProc(null);
        let holder: typeof original | undefined = original;

        killPetProcessWithGrace(
            () => holder,
            () => {
                holder = undefined;
            },
            outputChannel,
        );

        original.exitCode = 0;
        clock.tick(GRACE_MS);

        assert.ok(original.kill.calledOnceWithExactly('SIGTERM'), 'only SIGTERM, no SIGKILL for an exited child');
    });

    test('does not signal a child that had already exited, but still clears ownership', () => {
        const original = makeProc(143);
        let holder: typeof original | undefined = original;

        killPetProcessWithGrace(
            () => holder,
            () => {
                holder = undefined;
            },
            outputChannel,
        );
        clock.tick(GRACE_MS);

        assert.strictEqual(holder, undefined, 'ownership cleared even when no signal is needed');
        assert.strictEqual(original.kill.callCount, 0, 'no signals sent to an already-exited child');
        assert.ok(outputChannel.info.notCalled, 'no kill message logged when nothing is killed');
    });

    test('never kills a replacement child assigned during the grace period', () => {
        const original = makeProc(null);
        const replacement = makeProc(null);
        let holder: typeof original | undefined = original;

        killPetProcessWithGrace(
            () => holder,
            () => {
                holder = undefined;
            },
            outputChannel,
        );

        holder = replacement;
        clock.tick(GRACE_MS);

        assert.ok(original.kill.calledWith('SIGKILL'), 'the captured original is force-killed');
        assert.strictEqual(replacement.kill.callCount, 0, 'the replacement child is never signalled');
    });

    test('catches and logs SIGTERM errors without throwing, and still clears ownership', () => {
        const original = makeProc(null);
        original.kill = sinon.stub().throws(new Error('kill failed'));
        let holder: typeof original | undefined = original;

        assert.doesNotThrow(() =>
            killPetProcessWithGrace(
                () => holder,
                () => {
                    holder = undefined;
                },
                outputChannel,
            ),
        );

        assert.strictEqual(holder, undefined, 'ownership relinquished even when the kill throws');
        assert.ok(outputChannel.error.called, 'kill error is logged');

        clock.tick(GRACE_MS);
        assert.strictEqual(original.kill.callCount, 1, 'no SIGKILL scheduled after a SIGTERM failure');
    });
});
