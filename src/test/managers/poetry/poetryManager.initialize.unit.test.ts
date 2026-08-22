/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import { PythonProjectManager } from '../../../internal.api';
import { PoetryManager } from '../../../managers/poetry/poetryManager';
import * as poetryUtils from '../../../managers/poetry/poetryUtils';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { mockedVSCodeNamespaces } from '../../unittests';

/**
 * Tests for the failed-initialization retry behavior of PoetryManager.initialize().
 *
 * poetry is a "swallow" style manager: discovery exceptions are caught, logged and
 * reported via telemetry (initialize() never throws to its caller). The fix must
 * still clear the internal `_initialized` guard on a swallowed exception so a later
 * call retries, while always settling the captured deferred for concurrent waiters.
 */
suite('PoetryManager.initialize - retry after failure (swallow style)', () => {
    let getPoetryStub: sinon.SinonStub;
    let refreshPoetryStub: sinon.SinonStub;

    setup(() => {
        // poetry reads `workspace.getConfiguration('python').get('poetryPath')` inline;
        // give the (raw) vscode workspace mock a benign config so the read does not throw.
        when(mockedVSCodeNamespaces.workspace!.getConfiguration('python')).thenReturn({
            get: () => undefined,
        } as any);

        getPoetryStub = sinon.stub(poetryUtils, 'getPoetry').resolves('/usr/bin/poetry');
        refreshPoetryStub = sinon.stub(poetryUtils, 'refreshPoetry');
        sinon.stub(poetryUtils, 'getPoetryForGlobal').resolves(undefined);
        sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').resolves();
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
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

    function createManager(): PoetryManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        return new PoetryManager({} as NativePythonFinder, api, {} as PythonProjectManager);
    }

    test('swallowed failure clears state so a later call retries and succeeds', async () => {
        refreshPoetryStub.onFirstCall().rejects(new Error('boom'));
        refreshPoetryStub.onSecondCall().resolves([]);

        const mgr = createManager();

        await assert.doesNotReject(mgr.initialize(), 'initialize() must never throw to its caller');
        assert.strictEqual(refreshPoetryStub.callCount, 1);

        await mgr.initialize();
        assert.strictEqual(refreshPoetryStub.callCount, 2, 'a later call must retry after a failed run');

        await mgr.initialize();
        assert.strictEqual(refreshPoetryStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('swallowed failure settles concurrent waiters, then permits a retry', async () => {
        refreshPoetryStub.onFirstCall().rejects(new Error('boom'));
        refreshPoetryStub.onSecondCall().resolves([]);

        const mgr = createManager();

        const results = await Promise.allSettled([mgr.initialize(), mgr.initialize(), mgr.initialize()]);
        assert.ok(results.every((r) => r.status === 'fulfilled'), 'all concurrent waiters must settle');
        assert.strictEqual(refreshPoetryStub.callCount, 1, 'concurrent callers share one discovery run');

        await mgr.initialize();
        assert.strictEqual(refreshPoetryStub.callCount, 2, 'a fresh call retries after failure');
    });

    test('tool_not_found is treated as completed init and is not retried', async () => {
        getPoetryStub.resolves(undefined);
        refreshPoetryStub.resolves([]);

        const mgr = createManager();
        await mgr.initialize();
        await mgr.initialize();

        assert.strictEqual(refreshPoetryStub.callCount, 1, 'tool_not_found must not cause repeated discovery');
    });
});
