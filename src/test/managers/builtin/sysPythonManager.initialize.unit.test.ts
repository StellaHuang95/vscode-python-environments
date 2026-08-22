/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { anything, reset, when } from 'ts-mockito';
import { PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as cache from '../../../managers/builtin/cache';
import { SysPythonManager } from '../../../managers/builtin/sysPythonManager';
import * as utils from '../../../managers/builtin/utils';
import * as uvInstaller from '../../../managers/builtin/uvPythonInstaller';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { mockedVSCodeNamespaces } from '../../unittests';

/**
 * Tests for the failed-initialization retry behavior of SysPythonManager.initialize().
 *
 * system is a "throw" style manager: an exception during initialization propagates to
 * the caller. Discovery runs inside the raw vscode `window.withProgress`, so the mock is
 * configured to execute the task and the failure is injected at `refreshPythons` — the
 * real discovery call — mirroring the venv suite. The fix must clear the internal
 * `_initialized` guard on a thrown exception so a later call retries, while always
 * settling the captured deferred so concurrent waiters unblock.
 */
suite('SysPythonManager.initialize - retry after failure (throw style)', () => {
    let refreshPythonsStub: sinon.SinonStub;

    setup(() => {
        // system uses the raw vscode `window.withProgress`; make it execute the task so
        // discovery (refreshPythons) actually runs and a failure can be injected there.
        when(mockedVSCodeNamespaces.window!.withProgress(anything(), anything())).thenCall(
            (_options: any, task: any) => task({ report: sinon.stub() }, { isCancellationRequested: false }),
        );
        refreshPythonsStub = sinon.stub(utils, 'refreshPythons');
        // With an empty collection the manager offers a uv install; decline it so a
        // successful retry completes cleanly without prompting.
        sinon.stub(uvInstaller, 'promptInstallPythonViaUv').resolves(undefined);
        // loadEnvMap reads the persisted global env path; keep it empty for isolation.
        sinon.stub(cache, 'getSystemEnvForGlobal').resolves(undefined);
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceWarn');
    });

    teardown(() => {
        sinon.restore();
        reset(mockedVSCodeNamespaces.window!);
    });

    function createManager(): SysPythonManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        return new SysPythonManager({} as NativePythonFinder, api, {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
        } as any);
    }

    test('rethrows on failure but clears state so a later call retries', async () => {
        refreshPythonsStub.onFirstCall().rejects(new Error('discovery boom'));
        refreshPythonsStub.onSecondCall().resolves([]);

        const mgr = createManager();

        // Throw style: the failing call surfaces the error to its caller.
        await assert.rejects(mgr.initialize(), /discovery boom/);
        assert.strictEqual(refreshPythonsStub.callCount, 1);

        // A later call retries because the failed run cleared the guard.
        await assert.doesNotReject(mgr.initialize());
        assert.strictEqual(refreshPythonsStub.callCount, 2, 'a later call must retry after a failure');

        // Once initialized successfully, subsequent calls are a no-op.
        await mgr.initialize();
        assert.strictEqual(refreshPythonsStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('settles concurrent waiters during a failing run (leader rejects, waiter resolves)', async () => {
        refreshPythonsStub.rejects(new Error('discovery boom'));

        const mgr = createManager();

        const leader = mgr.initialize();
        const waiter = mgr.initialize();

        await assert.rejects(leader, /discovery boom/);
        await assert.doesNotReject(waiter);
        assert.strictEqual(refreshPythonsStub.callCount, 1, 'concurrent callers share one discovery run');
    });
});
