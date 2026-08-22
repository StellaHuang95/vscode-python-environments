/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

/**
 * Tests for the failed-initialization retry behavior of VenvManager.initialize().
 *
 * venv is a "throw" style manager: a discovery exception propagates to the caller.
 * The fix must, on a thrown exception, clear the internal `_initialized` guard so a
 * later call retries, while always settling the captured deferred so concurrent
 * waiters unblock (rather than deadlocking on a guard that never resolves).
 */
suite('VenvManager.initialize - retry after failure (throw style)', () => {
    let findVirtualEnvironmentsStub: sinon.SinonStub;

    setup(() => {
        findVirtualEnvironmentsStub = sinon.stub(venvUtils, 'findVirtualEnvironments');
        // loadEnvMap() reads the persisted global env path; keep it empty for isolation.
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        // Execute the withProgress callback synchronously so discovery actually runs.
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            return await (task as any)({ report: sinon.stub() }, { isCancellationRequested: false } as any);
        });
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
    });

    function createManager(): VenvManager {
        const api = {
            getEnvironments: sinon.stub().resolves([]),
            getPythonProject: sinon.stub().returns(undefined),
            getPythonProjects: sinon.stub().returns([]),
            refreshEnvironments: sinon.stub().resolves(undefined),
        } as any as PythonEnvironmentApi;
        const baseManager = {
            getEnvironments: sinon.stub().resolves([]),
        } as any as EnvironmentManager;
        return new VenvManager({} as NativePythonFinder, api, baseManager, {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
        } as any);
    }

    test('rethrows on failure but clears state so a later call retries and succeeds', async () => {
        findVirtualEnvironmentsStub.onFirstCall().rejects(new Error('discovery boom'));
        findVirtualEnvironmentsStub.onSecondCall().resolves([]);

        const mgr = createManager();

        // Throw style: the failing call surfaces the error to its caller.
        await assert.rejects(mgr.initialize(), /discovery boom/);
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1);

        // A later call retries because the failed run cleared the guard.
        await assert.doesNotReject(mgr.initialize());
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'a later call must retry after a failure');

        // Once initialized successfully, subsequent calls are a no-op.
        await mgr.initialize();
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('settles concurrent waiters during a failing run (leader rejects, waiter resolves)', async () => {
        findVirtualEnvironmentsStub.rejects(new Error('discovery boom'));

        const mgr = createManager();

        // The leader started discovery; the waiter shares the captured deferred.
        const leader = mgr.initialize();
        const waiter = mgr.initialize();

        // The leader surfaces the error (preserving throw-style behavior)...
        await assert.rejects(leader, /discovery boom/);
        // ...while the concurrent waiter settles without rejecting (no deadlock/unhandled rejection).
        await assert.doesNotReject(waiter);
        // Both shared a single discovery run.
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1, 'concurrent callers share one discovery run');

        // State was cleared, so a fresh call retries.
        findVirtualEnvironmentsStub.resetBehavior();
        findVirtualEnvironmentsStub.resolves([]);
        await assert.doesNotReject(mgr.initialize());
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'a fresh call retries after failure');
    });

    test('does not re-run discovery after a successful initialize()', async () => {
        findVirtualEnvironmentsStub.resolves([]);
        const mgr = createManager();

        await mgr.initialize();
        await mgr.initialize();

        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1);
    });
});
