/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { PythonEnvironment, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import { createDeferred } from '../../../common/utils/deferred';
import * as windowApis from '../../../common/window.apis';
import { PythonProjectManager } from '../../../internal.api';
import { PipenvManager } from '../../../managers/pipenv/pipenvManager';
import * as pipenvUtils from '../../../managers/pipenv/pipenvUtils';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { mockedVSCodeNamespaces } from '../../unittests';

/**
 * Tests for the failed-initialization retry behavior of PipenvManager.initialize().
 *
 * pipenv is a "swallow" style manager: discovery exceptions are caught, logged and
 * reported via telemetry (initialize() never throws to its caller). The fix must
 * still clear the internal `_initialized` guard on a swallowed exception so a later
 * call retries, while always settling the captured deferred for concurrent waiters.
 */
suite('PipenvManager.initialize - retry after failure (swallow style)', () => {
    let getPipenvStub: sinon.SinonStub;
    let refreshPipenvStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        // pipenv reads `workspace.getConfiguration('python').get('pipenvPath')` inline;
        // give the (raw) vscode workspace mock a benign config so the read does not throw.
        when(mockedVSCodeNamespaces.workspace!.getConfiguration('python')).thenReturn({
            get: () => undefined,
        } as any);

        getPipenvStub = sinon.stub(pipenvUtils, 'getPipenv').resolves('/usr/bin/pipenv');
        refreshPipenvStub = sinon.stub(pipenvUtils, 'refreshPipenv');
        sinon.stub(pipenvUtils, 'getPipenvForGlobal').resolves(undefined);
        sinon.stub(pipenvUtils, 'clearPipenvCache').resolves();
        sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').resolves();
        sendTelemetryStub = sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            return await (task as any)({ report: sinon.stub() }, { isCancellationRequested: false } as any);
        });
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceInfo');
    });

    teardown(() => {
        sinon.restore();
        reset(mockedVSCodeNamespaces.workspace!);
    });

    function createManager(): PipenvManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        return new PipenvManager({} as NativePythonFinder, api, {} as PythonProjectManager);
    }

    test('swallowed failure clears state so a later call retries and succeeds', async () => {
        refreshPipenvStub.onFirstCall().rejects(new Error('boom'));
        refreshPipenvStub.onSecondCall().resolves([]);

        const mgr = createManager();

        await assert.doesNotReject(mgr.initialize(), 'initialize() must never throw to its caller');
        assert.strictEqual(refreshPipenvStub.callCount, 1);

        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'a later call must retry after a failed run');

        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('swallowed failure settles concurrent waiters, then permits a retry', async () => {
        refreshPipenvStub.onFirstCall().rejects(new Error('boom'));
        refreshPipenvStub.onSecondCall().resolves([]);

        const mgr = createManager();

        const results = await Promise.allSettled([mgr.initialize(), mgr.initialize(), mgr.initialize()]);
        assert.ok(results.every((r) => r.status === 'fulfilled'), 'all concurrent waiters must settle');
        assert.strictEqual(refreshPipenvStub.callCount, 1, 'concurrent callers share one discovery run');

        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'a fresh call retries after failure');
    });

    test('tool_not_found is treated as completed init and is not retried', async () => {
        getPipenvStub.resolves(undefined);
        refreshPipenvStub.resolves([]);

        const mgr = createManager();
        await mgr.initialize();
        await mgr.initialize();

        assert.strictEqual(refreshPipenvStub.callCount, 1, 'tool_not_found must not cause repeated discovery');
    });

    test('a failing run does not clobber a deferred installed by a concurrent clearCache()+init', async () => {
        // Park the leader's discovery on a gate so it can fail *after* a concurrent
        // clearCache() resets the guard and a fresh initialize() installs a new deferred.
        const leaderGate = createDeferred<PythonEnvironment[]>();
        refreshPipenvStub.onFirstCall().returns(leaderGate.promise); // leader: pending until we reject
        refreshPipenvStub.onSecondCall().resolves([]); // the reinit after clearCache: succeeds

        const mgr = createManager();

        // Leader starts discovery and suspends on the gate (its deferred becomes the active guard).
        const leader = mgr.initialize();
        await new Promise((resolve) => setImmediate(resolve));

        // A concurrent clearCache() clears the guard; a fresh initialize() installs a *new* deferred.
        await mgr.clearCache!();
        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'the reinit runs its own discovery');

        // Now fail the leader. Its catch must NOT clear the guard, because the active
        // deferred is now the reinit's, not the leader's.
        leaderGate.reject(new Error('late boom'));
        await assert.doesNotReject(leader, 'swallow style: the leader never throws to its caller');

        // The reinit's successful state must survive, so no third discovery is triggered.
        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'a failing run must not clobber a newer deferred');
    });

    test('telemetry failure in finally settles waiters and does not surface to callers', async () => {
        refreshPipenvStub.resolves([]);
        // The telemetry reporter throws while the manager settles its captured deferred.
        sendTelemetryStub.withArgs(EventNames.MANAGER_LAZY_INIT).throws(new Error('telemetry boom'));

        const mgr = createManager();

        // The captured deferred is resolved before telemetry runs, so a telemetry failure must
        // neither reject initialize() (swallow-style contract) nor leave a shared waiter hanging.
        const results = await Promise.allSettled([mgr.initialize(), mgr.initialize()]);
        assert.ok(
            results.every((r) => r.status === 'fulfilled'),
            'a telemetry failure must not reject or deadlock initialize()',
        );
        assert.strictEqual(refreshPipenvStub.callCount, 1, 'concurrent callers share one discovery run');

        // Discovery succeeded, so the guard stays set — a telemetry failure must not force re-discovery.
        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 1, 'a telemetry failure must not force re-discovery');
    });
});
