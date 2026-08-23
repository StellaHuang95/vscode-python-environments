/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

suite('VenvManager.initialize - retry after failure (throw style)', () => {
    let findVirtualEnvironmentsStub: sinon.SinonStub;

    setup(() => {
        findVirtualEnvironmentsStub = sinon.stub(venvUtils, 'findVirtualEnvironments');
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
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

        await assert.rejects(mgr.initialize(), /discovery boom/);
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1);

        await assert.doesNotReject(mgr.initialize());
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'a later call must retry after a failure');

        await mgr.initialize();
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'no re-discovery after a successful init');
    });

    test('settles concurrent waiters during a failing run (leader rejects, waiter resolves)', async () => {
        findVirtualEnvironmentsStub.rejects(new Error('discovery boom'));

        const mgr = createManager();

        const leader = mgr.initialize();
        const waiter = mgr.initialize();

        await assert.rejects(leader, /discovery boom/);
        await assert.doesNotReject(waiter);
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1, 'concurrent callers share one discovery run');

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
