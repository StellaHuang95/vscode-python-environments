/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { Uri } from 'vscode';
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
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';
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
    let getPipenvForGlobalStub: sinon.SinonStub;
    let getPipenvForWorkspaceStub: sinon.SinonStub;
    let notifyMissingStub: sinon.SinonStub;

    setup(() => {
        // pipenv reads `workspace.getConfiguration('python').get('pipenvPath')` inline;
        // give the (raw) vscode workspace mock a benign config so the read does not throw.
        when(mockedVSCodeNamespaces.workspace!.getConfiguration('python')).thenReturn({
            get: () => undefined,
        } as any);

        getPipenvStub = sinon.stub(pipenvUtils, 'getPipenv').resolves('/usr/bin/pipenv');
        refreshPipenvStub = sinon.stub(pipenvUtils, 'refreshPipenv');
        getPipenvForGlobalStub = sinon.stub(pipenvUtils, 'getPipenvForGlobal').resolves(undefined);
        getPipenvForWorkspaceStub = sinon.stub(pipenvUtils, 'getPipenvForWorkspace').resolves(undefined);
        sinon.stub(pipenvUtils, 'clearPipenvCache').resolves();
        notifyMissingStub = sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').resolves();
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

    function createManagerWithProjects(projectUris: Uri[]): PipenvManager {
        const projects = projectUris.map((uri) => ({ uri }));
        const api = {
            getPythonProjects: sinon.stub().returns(projects),
            getPythonProject: sinon
                .stub()
                .callsFake((u: Uri) => projects.find((p) => p.uri.fsPath === u.fsPath)),
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

    test('a late successful initialization does not overwrite newer committed state', async () => {
        const envAPath = path.resolve('pipenv-A', 'bin', 'python');
        const envBPath = path.resolve('pipenv-B', 'bin', 'python');
        const envA = createMockPythonEnvironment({
            name: 'A',
            envPath: envAPath,
            id: 'A',
            managerId: 'ms-python.python:pipenv',
        });
        const envB = createMockPythonEnvironment({
            name: 'B',
            envPath: envBPath,
            id: 'B',
            managerId: 'ms-python.python:pipenv',
        });

        // Leader A parks on the gate; the reinit B (after clearCache) commits its own state first.
        const gateA = createDeferred<PythonEnvironment[]>();
        refreshPipenvStub.onFirstCall().returns(gateA.promise);
        refreshPipenvStub.onSecondCall().resolves([envB]);
        getPipenvForGlobalStub.resolves(envBPath); // B's global resolves to envB (envBPath is not in [envA])

        const mgr = createManager();

        // A starts discovery and suspends on the gate (its deferred becomes the active guard).
        const leaderA = mgr.initialize();
        await new Promise((resolve) => setImmediate(resolve));

        // A concurrent clearCache() clears the guard; a fresh initialize() (B) installs a new
        // deferred and commits its collection + global environment.
        await mgr.clearCache!();
        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'the reinit runs its own discovery');
        assert.deepStrictEqual(
            (await mgr.getEnvironments('all')).map((e) => e.envId.id),
            ['B'],
            'B committed its own collection',
        );
        assert.strictEqual(await mgr.get(undefined), envB, 'B committed its own global environment');

        // Now A finishes SUCCESSFULLY but late. Because B now owns initialization, A must discard
        // its results rather than clobber B's newer committed state.
        gateA.resolve([envA]);
        await assert.doesNotReject(leaderA, 'swallow style: the superseded leader never throws');

        assert.deepStrictEqual(
            (await mgr.getEnvironments('all')).map((e) => e.envId.id),
            ['B'],
            "a late successful A must not overwrite B's collection",
        );
        assert.strictEqual(await mgr.get(undefined), envB, "a late successful A must not overwrite B's global env");
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'no extra discovery is triggered');
    });

    test('a mid-map failure commits nothing and a retry with changed discovery leaves no stale mappings', async () => {
        const projX = Uri.file(path.resolve('proj-X'));
        const projY = Uri.file(path.resolve('proj-Y'));
        const envOldPath = path.resolve('pipenv-old', 'bin', 'python');
        const envNewPath = path.resolve('pipenv-new', 'bin', 'python');
        const envOld = createMockPythonEnvironment({
            name: 'old',
            envPath: envOldPath,
            id: 'old',
            managerId: 'ms-python.python:pipenv',
        });
        const envNew = createMockPythonEnvironment({
            name: 'new',
            envPath: envNewPath,
            id: 'new',
            managerId: 'ms-python.python:pipenv',
        });

        // Run A: discovery succeeds, but building the map throws partway (on the second project).
        refreshPipenvStub.onFirstCall().resolves([envOld]);
        getPipenvForWorkspaceStub.onCall(0).resolves(envOldPath); // A: projX -> envOld (into A's discarded local map)
        getPipenvForWorkspaceStub.onCall(1).rejects(new Error('map boom')); // A: projY read throws

        // Retry B: discovery *changed* — projX is no longer a pipenv project, projY now maps to envNew.
        refreshPipenvStub.onSecondCall().resolves([envNew]);
        getPipenvForWorkspaceStub.onCall(2).resolves(undefined); // B: projX -> none
        getPipenvForWorkspaceStub.onCall(3).resolves(envNewPath); // B: projY -> envNew

        const mgr = createManagerWithProjects([projX, projY]);

        // A swallows the map failure. Because state is built into locals and committed atomically,
        // nothing partial is written and the guard is cleared for a retry.
        await assert.doesNotReject(mgr.initialize(), 'swallow style: a map failure never throws to the caller');
        assert.strictEqual(refreshPipenvStub.callCount, 1, 'A ran discovery once');

        // Retry: B commits cleanly. The guard was cleared, so a fresh discovery runs.
        await mgr.initialize();
        assert.strictEqual(refreshPipenvStub.callCount, 2, 'the failed run cleared the guard so B retried');

        assert.deepStrictEqual(
            (await mgr.getEnvironments('all')).map((e) => e.envId.id),
            ['new'],
            'B committed only its own collection',
        );
        // projX disappeared from discovery on retry — a partial A run must not leave it mapped to envOld.
        assert.deepStrictEqual(await mgr.getEnvironments(projX), [], 'no stale projX -> envOld mapping survives');
        assert.deepStrictEqual(
            (await mgr.getEnvironments(projY)).map((e) => e.envId.id),
            ['new'],
            'projY maps to the newly discovered environment',
        );
    });

    test('a superseded run skips post-discovery tool lookup and missing-manager notification', async () => {
        // Neither run finds a pipenv tool, so the post-discovery path would call getPipenv() again
        // and notifyMissingManagerIfDefault(). Only the run that actually commits (B) should do
        // that — a superseded A must not re-run tool lookup or double-notify for state it discarded.
        getPipenvStub.resolves(undefined); // tool never found (pre- or post-refresh)

        const gateA = createDeferred<PythonEnvironment[]>();
        refreshPipenvStub.onFirstCall().returns(gateA.promise); // A parks in discovery
        refreshPipenvStub.onSecondCall().resolves([]); // B commits an empty collection

        const mgr = createManager();

        // A starts discovery and suspends on the gate (its deferred becomes the active guard).
        const leaderA = mgr.initialize();
        await new Promise((resolve) => setImmediate(resolve));

        // B takes over via clearCache()+init and commits, running the post-discovery bookkeeping.
        await mgr.clearCache!();
        await mgr.initialize();
        assert.strictEqual(notifyMissingStub.callCount, 1, 'only the committing run notifies a missing manager');
        const getPipenvCallsAfterB = getPipenvStub.callCount;

        // A finishes late but is superseded: it must not re-run tool lookup or notify again.
        gateA.resolve([]);
        await assert.doesNotReject(leaderA, 'swallow style: the superseded leader never throws');

        assert.strictEqual(notifyMissingStub.callCount, 1, 'a superseded run does not notify a missing manager again');
        assert.strictEqual(
            getPipenvStub.callCount,
            getPipenvCallsAfterB,
            'a superseded run does not re-run post-discovery tool lookup',
        );
    });
});
