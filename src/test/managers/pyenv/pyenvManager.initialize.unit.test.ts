/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import { EventNames } from '../../../common/telemetry/constants';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import { PythonProjectManager } from '../../../internal.api';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { PyEnvManager } from '../../../managers/pyenv/pyenvManager';
import * as pyenvUtils from '../../../managers/pyenv/pyenvUtils';

/**
 * Tests for the failed-initialization retry behavior of PyEnvManager.initialize().
 *
 * pyenv is a "swallow" style manager: discovery exceptions are caught, logged and
 * reported via telemetry (initialize() never throws to its caller). The fix must
 * still clear the internal `_initialized` guard on a swallowed exception so a later
 * call retries, while always settling the captured deferred for concurrent waiters.
 */
suite('PyEnvManager.initialize - retry after failure (swallow style)', () => {
    let getPyenvStub: sinon.SinonStub;
    let refreshPyenvStub: sinon.SinonStub;
    let sendTelemetryStub: sinon.SinonStub;

    setup(() => {
        getPyenvStub = sinon.stub(pyenvUtils, 'getPyenv').resolves('/usr/bin/pyenv');
        refreshPyenvStub = sinon.stub(pyenvUtils, 'refreshPyenv');
        sinon.stub(pyenvUtils, 'getPyenvForGlobal').resolves(undefined);
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
    });

    function createManager(): PyEnvManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        return new PyEnvManager({} as NativePythonFinder, api, {} as PythonProjectManager);
    }

    test('swallowed failure clears state so a later call retries and succeeds', async () => {
        refreshPyenvStub.onFirstCall().rejects(new Error('boom'));
        refreshPyenvStub.onSecondCall().resolves([]);

        const mgr = createManager();

        // Swallow style: initialize() must not throw to its caller even when discovery fails.
        await assert.doesNotReject(mgr.initialize(), 'initialize() must never throw to its caller');
        assert.strictEqual(refreshPyenvStub.callCount, 1);

        // The failed run cleared the guard, so a later call retries.
        await mgr.initialize();
        assert.strictEqual(refreshPyenvStub.callCount, 2, 'a later call must retry after a failed run');

        // After a successful run, further calls are a no-op.
        await mgr.initialize();
        assert.strictEqual(refreshPyenvStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('swallowed failure settles concurrent waiters, then permits a retry', async () => {
        refreshPyenvStub.onFirstCall().rejects(new Error('boom'));
        refreshPyenvStub.onSecondCall().resolves([]);

        const mgr = createManager();

        const results = await Promise.allSettled([mgr.initialize(), mgr.initialize(), mgr.initialize()]);
        assert.ok(results.every((r) => r.status === 'fulfilled'), 'all concurrent waiters must settle');
        assert.strictEqual(refreshPyenvStub.callCount, 1, 'concurrent callers share one discovery run');

        await mgr.initialize();
        assert.strictEqual(refreshPyenvStub.callCount, 2, 'a fresh call retries after failure');
    });

    test('tool_not_found is treated as completed init and is not retried', async () => {
        // pyenv absent (no tool found), but discovery itself does not throw.
        getPyenvStub.resolves(undefined);
        refreshPyenvStub.resolves([]);

        const mgr = createManager();
        await mgr.initialize();
        await mgr.initialize();

        assert.strictEqual(refreshPyenvStub.callCount, 1, 'tool_not_found must not cause repeated discovery');
    });

    test('telemetry failure in finally settles waiters and does not surface to callers', async () => {
        refreshPyenvStub.resolves([]);
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
        assert.strictEqual(refreshPyenvStub.callCount, 1, 'concurrent callers share one discovery run');

        // Discovery succeeded, so the guard stays set — a telemetry failure must not force re-discovery.
        await mgr.initialize();
        assert.strictEqual(refreshPyenvStub.callCount, 1, 'a telemetry failure must not force re-discovery');
    });
});
