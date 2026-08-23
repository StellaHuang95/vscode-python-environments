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

suite('SysPythonManager.initialize - retry after failure (throw style)', () => {
    let refreshPythonsStub: sinon.SinonStub;

    setup(() => {
        when(mockedVSCodeNamespaces.window!.withProgress(anything(), anything())).thenCall(
            (_options: any, task: any) => task({ report: sinon.stub() }, { isCancellationRequested: false }),
        );
        refreshPythonsStub = sinon.stub(utils, 'refreshPythons');
        sinon.stub(uvInstaller, 'promptInstallPythonViaUv').resolves(undefined);
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

        await assert.rejects(mgr.initialize(), /discovery boom/);
        assert.strictEqual(refreshPythonsStub.callCount, 1);

        await assert.doesNotReject(mgr.initialize());
        assert.strictEqual(refreshPythonsStub.callCount, 2, 'a later call must retry after a failure');

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
