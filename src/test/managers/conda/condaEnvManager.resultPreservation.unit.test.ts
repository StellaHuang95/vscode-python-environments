/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { EnvironmentChangeKind, PythonEnvironmentApi, PythonProject } from '../../../api';
import * as logging from '../../../common/logging';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaSourcingUtils from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { createMockPythonEnvironment, makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

suite('CondaEnvManager - result preservation on discovery failure', () => {
    let getCondaStub: sinon.SinonStub;
    let refreshCondaEnvsStub: sinon.SinonStub;
    let getCondaForGlobalStub: sinon.SinonStub;
    let getCondaForWorkspaceStub: sinon.SinonStub;
    let resolveCondaPathStub: sinon.SinonStub;

    setup(() => {
        getCondaStub = sinon.stub(condaUtils, 'getConda').resolves('/usr/bin/conda');
        sinon.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        refreshCondaEnvsStub = sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        getCondaForGlobalStub = sinon.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        getCondaForWorkspaceStub = sinon.stub(condaUtils, 'getCondaForWorkspace').resolves(undefined);
        resolveCondaPathStub = sinon.stub(condaUtils, 'resolveCondaPath').resolves(undefined);
        sinon.stub(condaSourcingUtils, 'constructCondaSourcingStatus').resolves({ toString: () => '' } as any);
        sinon.stub(commonUtils, 'notifyMissingManagerIfDefault').resolves();
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(windowApis, 'withProgress').callsFake(async (_options, task) => {
            return await (task as any)({ report: sinon.stub() }, { isCancellationRequested: false } as any);
        });
        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceVerbose');
    });

    teardown(() => {
        sinon.restore();
    });

    test('refresh preserves prior environments and emits no changes when discovery fails and nothing persisted resolves', async () => {
        const known = [base(), envB()];
        refreshCondaEnvsStub.resolves(known);

        const mgr = createManager();
        await mgr.initialize();
        assert.strictEqual((await mgr.getEnvironments('all')).length, 2, 'precondition: two envs discovered');

        const events = collectEvents(mgr);
        refreshCondaEnvsStub.resolves(undefined);
        await mgr.refresh(undefined);

        assert.strictEqual(events.length, 0, 'a failed refresh must not emit any environment changes');
        const after = await mgr.getEnvironments('all');
        assert.deepStrictEqual(
            after.map((e) => e.name).sort(),
            ['base', 'envB'],
            'the known-good collection must survive a failed refresh',
        );
    });

    test('refresh empties the collection and emits removals on a successful empty result', async () => {
        const known = [base(), envB()];
        refreshCondaEnvsStub.resolves(known);

        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);
        refreshCondaEnvsStub.resolves([]);
        await mgr.refresh(undefined);

        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove).map((e) => e.environment.name);
        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add);
        assert.deepStrictEqual(removed.sort(), ['base', 'envB'], 'stale environments must be removed on empty success');
        assert.strictEqual(added.length, 0, 'no environments should be added for an empty result');
        assert.strictEqual((await mgr.getEnvironments('all')).length, 0, 'collection must be emptied');
    });

    test('refresh replaces the collection and emits removals + adds on a successful non-empty result', async () => {
        refreshCondaEnvsStub.resolves([base()]);

        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);
        const envC = makeEnv('envC', Uri.file('/opt/miniconda3/envs/envC').fsPath, '3.10.0');
        refreshCondaEnvsStub.resolves([envC]);
        await mgr.refresh(undefined);

        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove).map((e) => e.environment.name);
        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        assert.deepStrictEqual(removed, ['base'], 'old environment removed');
        assert.deepStrictEqual(added, ['envC'], 'new environment added');
        assert.deepStrictEqual((await mgr.getEnvironments('all')).map((e) => e.name), ['envC']);
    });

    test('initialize leaves the collection empty and emits no changes when discovery fails and nothing persisted resolves', async () => {
        refreshCondaEnvsStub.resolves(undefined);

        const mgr = createManager();
        const events = collectEvents(mgr);
        await mgr.initialize();

        assert.strictEqual(getCondaStub.called, true, 'initialize still attempts discovery');
        assert.strictEqual(events.length, 0, 'a failed initial discovery must not emit environment changes');
        assert.strictEqual((await mgr.getEnvironments('all')).length, 0, 'no environments should be registered');
    });

    test('refresh failure preserves the collection and restores a persisted global selection, emitting only its addition', async () => {
        const known = [base()];
        refreshCondaEnvsStub.resolves(known);

        const mgr = createManager();
        await mgr.initialize();
        assert.strictEqual((await mgr.getEnvironments('all')).length, 1, 'precondition: one env discovered');

        const events = collectEvents(mgr);

        const persistedGlobalPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const persistedEnv = makeEnv('persisted', persistedGlobalPath, '3.9.0');
        getCondaForGlobalStub.resolves(persistedGlobalPath);
        resolveCondaPathStub.resolves(persistedEnv);
        refreshCondaEnvsStub.resolves(undefined);

        await mgr.refresh(undefined);

        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        assert.strictEqual(removed.length, 0, 'no removals on failed discovery');
        assert.deepStrictEqual(added, ['persisted'], 'only the restored persisted env is emitted as an addition');

        const all = (await mgr.getEnvironments('all')).map((e) => e.name).sort();
        assert.deepStrictEqual(all, ['base', 'persisted'], 'old collection preserved and persisted env appended');
        assert.strictEqual(await mgr.get(undefined), persistedEnv, 'persisted global selection is retained');
    });

    test('initialize failure restores a persisted global selection and retains it across get calls, emitting only its addition', async () => {
        refreshCondaEnvsStub.resolves(undefined);

        const persistedGlobalPath = Uri.file('/opt/miniconda3').fsPath;
        const persistedEnv = makeEnv('base', persistedGlobalPath, '3.12.0');
        getCondaForGlobalStub.resolves(persistedGlobalPath);
        resolveCondaPathStub.resolves(persistedEnv);

        const mgr = createManager();
        const events = collectEvents(mgr);
        await mgr.initialize();

        assert.strictEqual((mgr as any)._initialized, undefined, 'a failed initialization stays retryable');

        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        assert.strictEqual(removed.length, 0, 'no removals on failed initial discovery');
        assert.deepStrictEqual(added, ['base'], 'only the restored persisted env is emitted');

        assert.strictEqual(await mgr.get(undefined), persistedEnv, 'first get returns the persisted selection');
        assert.strictEqual(await mgr.get(undefined), persistedEnv, 'subsequent get returns the persisted selection');
        assert.deepStrictEqual((await mgr.getEnvironments('all')).map((e) => e.name), ['base']);
    });

    test('fast/background get: refresh failure restores a persisted workspace selection and retains it across calls', async () => {
        const workspaceUri = Uri.file(path.resolve('ws-conda'));
        const project = { uri: workspaceUri } as PythonProject;
        const api = {
            getPythonProjects: sinon.stub().returns([project]),
            getPythonProject: sinon.stub().returns(project),
        } as any as PythonEnvironmentApi;
        const mgr = new CondaEnvManager(
            {} as NativePythonFinder,
            api,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
        );

        const persistedPath = Uri.file(path.resolve('ws-conda', '.conda')).fsPath;
        const persistedEnv = makeEnv('wsenv', persistedPath, '3.10.0');
        getCondaForWorkspaceStub.resolves(persistedPath);
        resolveCondaPathStub.resolves(persistedEnv);
        refreshCondaEnvsStub.resolves(undefined);
        sinon.stub(fs.promises, 'access').resolves();

        const events = collectEvents(mgr);

        const first = await mgr.get(workspaceUri);
        assert.strictEqual(first, persistedEnv, 'fast path returns the persisted env on first get');

        await (mgr as any)._initialized?.promise;
        await new Promise((resolve) => setImmediate(resolve));

        const second = await mgr.get(workspaceUri);
        assert.strictEqual(second, persistedEnv, 'persisted selection retained after settled init');

        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        assert.strictEqual(removed.length, 0, 'no removals on failed background discovery');
        const wsAdds = events.filter((e) => e.kind === EnvironmentChangeKind.add && e.environment.name === 'wsenv');
        assert.strictEqual(wsAdds.length, 1, `expected exactly one add for the persisted env, got ${wsAdds.length}`);

        const wsInCollection = (await mgr.getEnvironments('all')).filter((e) => e.name === 'wsenv');
        assert.strictEqual(wsInCollection.length, 1, 'exactly one collection entry for the persisted env');
    });

    test('failed discovery announces only environments this loadEnvMap appended when a concurrent refresh replaces the collection', async () => {
        refreshCondaEnvsStub.resolves([base()]);
        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);

        const persistedGlobalPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const persistedEnv = makeEnv('persisted', persistedGlobalPath, '3.9.0');
        getCondaForGlobalStub.resolves(persistedGlobalPath);

        let releaseResolve!: (env: any) => void;
        const gate = new Promise<any>((resolve) => {
            releaseResolve = resolve;
        });
        resolveCondaPathStub.returns(gate);
        refreshCondaEnvsStub.resolves(undefined);

        const failedRefresh = mgr.refresh(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        const foreignEnv = makeEnv('foreign', Uri.file('/opt/miniconda3/envs/foreign').fsPath, '3.10.0');
        (mgr as any).collection = [foreignEnv];

        releaseResolve(persistedEnv);
        await failedRefresh;

        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        assert.deepStrictEqual(added, ['persisted'], 'only the env appended by this loadEnvMap call is announced');
        assert.strictEqual(removed.length, 0, 'the failure path never emits removals');

        const names = (await mgr.getEnvironments('all')).map((e) => e.name).sort();
        assert.deepStrictEqual(names, ['foreign', 'persisted'], 'concurrent replacement kept; persisted appended once');
    });

    test('two overlapping failed refreshes append a shared persisted env only once', async () => {
        refreshCondaEnvsStub.resolves([base()]);
        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);

        const persistedGlobalPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        getCondaForGlobalStub.resolves(persistedGlobalPath);
        refreshCondaEnvsStub.resolves(undefined);

        let releaseA!: (env: any) => void;
        let releaseB!: (env: any) => void;
        const gateA = new Promise<any>((resolve) => {
            releaseA = resolve;
        });
        const gateB = new Promise<any>((resolve) => {
            releaseB = resolve;
        });
        resolveCondaPathStub.onCall(0).returns(gateA);
        resolveCondaPathStub.onCall(1).returns(gateB);

        const refreshA = mgr.refresh(undefined);
        const refreshB = mgr.refresh(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        releaseA(makeEnv('persisted', persistedGlobalPath, '3.9.0'));
        releaseB(makeEnv('persisted', persistedGlobalPath, '3.9.0'));
        await Promise.all([refreshA, refreshB]);

        const persistedAdds = events.filter(
            (e) => e.kind === EnvironmentChangeKind.add && e.environment.name === 'persisted',
        );
        assert.strictEqual(persistedAdds.length, 1, 'the shared persisted env is announced exactly once');
        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        assert.strictEqual(removed.length, 0, 'no removals on failed discovery');

        const persistedEntries = (await mgr.getEnvironments('all')).filter((e) => e.name === 'persisted');
        assert.strictEqual(persistedEntries.length, 1, 'exactly one collection entry for the shared persisted env');
    });

    test('failed discovery does not announce an appended env that a concurrent successful refresh dropped from the collection', async () => {
        const workspaceUri = Uri.file(path.resolve('ws-stale-add'));
        const project = { uri: workspaceUri } as PythonProject;
        const api = {
            getPythonProjects: sinon.stub().returns([project]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        const mgr = new CondaEnvManager(
            {} as NativePythonFinder,
            api,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
        );

        refreshCondaEnvsStub.resolves([base()]);
        await mgr.initialize();

        const events = collectEvents(mgr);

        const persistedGlobalPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const persistedEnv = makeEnv('persisted', persistedGlobalPath, '3.9.0');
        getCondaForGlobalStub.resolves(persistedGlobalPath);
        resolveCondaPathStub.resolves(persistedEnv);
        refreshCondaEnvsStub.resolves(undefined);

        let releaseWorkspace!: (value: any) => void;
        const workspaceGate = new Promise<any>((resolve) => {
            releaseWorkspace = resolve;
        });
        getCondaForWorkspaceStub.returns(workspaceGate);

        const failedRefresh = mgr.refresh(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        const foreignEnv = makeEnv('foreign', Uri.file('/opt/miniconda3/envs/foreign').fsPath, '3.10.0');
        (mgr as any).collection = [foreignEnv];

        releaseWorkspace(undefined);
        await failedRefresh;

        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        assert.deepStrictEqual(added, [], 'an appended env dropped by a concurrent refresh must not be announced');
        assert.strictEqual(removed.length, 0, 'the failure path never emits removals');

        const names = (await mgr.getEnvironments('all')).map((e) => e.name).sort();
        assert.deepStrictEqual(names, ['foreign'], 'the concurrently-refreshed collection is left intact');
    });

    test('successful refresh announces only its own results/appends, not an env a concurrent failed refresh appended', async () => {
        const mgr = createManager();
        (mgr as any).collection = [base()];

        const events = collectEvents(mgr);

        const persistedPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const persistedEnv = makeEnv('persisted', persistedPath, '3.9.0');
        const refreshedBase = base();

        let releaseGlobalS!: (value: any) => void;
        const globalGateS = new Promise<any>((resolve) => {
            releaseGlobalS = resolve;
        });

        refreshCondaEnvsStub.onCall(0).resolves([refreshedBase]);
        refreshCondaEnvsStub.onCall(1).resolves(undefined);
        getCondaForGlobalStub.onCall(0).returns(globalGateS);
        getCondaForGlobalStub.onCall(1).resolves(persistedPath);
        resolveCondaPathStub.resolves(persistedEnv);

        const successfulRefresh = mgr.refresh(undefined);
        const failedRefresh = mgr.refresh(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        releaseGlobalS(undefined);
        await Promise.all([successfulRefresh, failedRefresh]);

        const persistedAdds = events.filter(
            (e) => e.kind === EnvironmentChangeKind.add && e.environment.name === 'persisted',
        );
        assert.strictEqual(persistedAdds.length, 1, 'the persisted env is announced once, not re-announced by success');

        const persistedEntries = (mgr as any).collection.filter((e: any) => e.name === 'persisted');
        assert.strictEqual(persistedEntries.length, 1, 'exactly one collection entry for the persisted env');
    });

    test('failed initialization preserves known/persisted data and stays retryable', async () => {
        refreshCondaEnvsStub.resolves(undefined);

        const mgr = createManager();
        (mgr as any).collection = [base()];

        const persistedGlobalPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const persistedEnv = makeEnv('persisted', persistedGlobalPath, '3.9.0');
        getCondaForGlobalStub.resolves(persistedGlobalPath);
        resolveCondaPathStub.resolves(persistedEnv);

        const events = collectEvents(mgr);
        await mgr.initialize();

        assert.strictEqual((mgr as any)._initialized, undefined, 'a failed initialization stays retryable');
        const removed = events.filter((e) => e.kind === EnvironmentChangeKind.remove);
        const added = events.filter((e) => e.kind === EnvironmentChangeKind.add).map((e) => e.environment.name);
        assert.strictEqual(removed.length, 0, 'no removals on failed initial discovery');
        assert.deepStrictEqual(added, ['persisted'], 'only the restored persisted env is announced');

        const names = (mgr as any).collection.map((e: any) => e.name).sort();
        assert.deepStrictEqual(names, ['base', 'persisted'], 'known env preserved and persisted env restored');
    });

    test('concurrent initialize waiters share a single failed attempt and remain retryable', async () => {
        refreshCondaEnvsStub.resolves(undefined);

        const mgr = createManager();
        const first = mgr.initialize();
        const second = mgr.initialize();
        await Promise.all([first, second]);

        assert.strictEqual(refreshCondaEnvsStub.callCount, 1, 'concurrent waiters share a single discovery attempt');
        assert.strictEqual((mgr as any)._initialized, undefined, 'the shared failed attempt stays retryable');
    });

    test('a later get retries once after a failed initialization and stays initialized after success', async () => {
        refreshCondaEnvsStub.onCall(0).resolves(undefined);
        refreshCondaEnvsStub.onCall(1).resolves([base()]);

        const mgr = createManager();

        await mgr.get(undefined);
        assert.strictEqual(refreshCondaEnvsStub.callCount, 1, 'the failed initialization ran discovery once');
        assert.strictEqual((mgr as any)._initialized, undefined, 'the failed initialization is retryable');

        await mgr.get(undefined);
        assert.strictEqual(refreshCondaEnvsStub.callCount, 2, 'the next get retried discovery exactly once');
        assert.strictEqual((mgr as any)._initialized?.completed, true, 'a successful retry stays initialized');
        assert.deepStrictEqual(
            (mgr as any).collection.map((e: any) => e.name),
            ['base'],
            'the successful retry populated the collection',
        );

        await mgr.get(undefined);
        assert.strictEqual(refreshCondaEnvsStub.callCount, 2, 'a settled initialization does not retry again');
    });

    test('a delayed successful refresh does not remove/re-add a path a prior failed refresh already announced', async () => {
        const mgr = createManager();
        (mgr as any).collection = [base()];

        const events = collectEvents(mgr);

        const persistedPath = Uri.file('/opt/miniconda3/envs/persisted').fsPath;
        const failedEnv = createMockPythonEnvironment({
            name: 'persisted',
            envPath: persistedPath,
            version: '3.9.0',
            id: 'persisted-failed',
        });
        const successEnv = createMockPythonEnvironment({
            name: 'persisted',
            envPath: persistedPath,
            version: '3.9.0',
            id: 'persisted-success',
        });
        getCondaForGlobalStub.resolves(persistedPath);
        resolveCondaPathStub.onCall(0).resolves(failedEnv);
        resolveCondaPathStub.onCall(1).resolves(successEnv);

        let releaseSuccess!: (envs: any) => void;
        const successGate = new Promise<any>((resolve) => {
            releaseSuccess = resolve;
        });
        refreshCondaEnvsStub.onCall(0).returns(successGate);
        refreshCondaEnvsStub.onCall(1).resolves(undefined);

        const successfulRefresh = mgr.refresh(undefined);
        const failedRefresh = mgr.refresh(undefined);

        await failedRefresh;
        assert.deepStrictEqual(
            events.map((e) => `${e.kind}:${e.environment.name}`),
            ['add:persisted'],
            'the failed refresh announces the restored persisted env once',
        );

        releaseSuccess([base()]);
        await successfulRefresh;

        assert.deepStrictEqual(
            events.map((e) => `${e.kind}:${e.environment.name}`),
            ['add:persisted'],
            'the delayed successful refresh emits no remove/re-add for the continuous path',
        );

        const persistedEntries = (mgr as any).collection.filter((e: any) => e.name === 'persisted');
        assert.strictEqual(persistedEntries.length, 1, 'exactly one collection entry for the persisted path');
        const names = (mgr as any).collection.map((e: any) => e.name).sort();
        assert.deepStrictEqual(names, ['base', 'persisted'], 'final collection retains base and the single persisted entry');
    });

    test('fast/background get: a failed background initialization stays retryable and the next get retries and succeeds', async () => {
        const workspaceUri = Uri.file(path.resolve('ws-retry'));
        const project = { uri: workspaceUri } as PythonProject;
        const api = {
            getPythonProjects: sinon.stub().returns([project]),
            getPythonProject: sinon.stub().returns(project),
        } as any as PythonEnvironmentApi;
        const mgr = new CondaEnvManager(
            {} as NativePythonFinder,
            api,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
        );

        const persistedPath = Uri.file(path.resolve('ws-retry', '.conda')).fsPath;
        const persistedEnv = makeEnv('wsenv', persistedPath, '3.10.0');
        getCondaForWorkspaceStub.resolves(persistedPath);
        resolveCondaPathStub.resolves(persistedEnv);
        sinon.stub(fs.promises, 'access').resolves();
        refreshCondaEnvsStub.onCall(0).resolves(undefined);
        refreshCondaEnvsStub.onCall(1).resolves([base()]);

        const first = await mgr.get(workspaceUri);
        assert.strictEqual(first, persistedEnv, 'fast path returns the persisted env despite background failure');
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual((mgr as any)._initialized, undefined, 'a failed background initialization stays retryable');

        const second = await mgr.get(workspaceUri);
        assert.strictEqual(second, persistedEnv, 'the persisted env is retained on the retry');
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(refreshCondaEnvsStub.callCount, 2, 'the next get retried background discovery exactly once');
        assert.strictEqual((mgr as any)._initialized?.completed, true, 'a successful retry stays initialized');
        const names = (await mgr.getEnvironments('all')).map((e) => e.name).sort();
        assert.deepStrictEqual(names, ['base', 'wsenv'], 'the successful retry populated the collection');
    });

    test('successful refresh emits no events when a same-path environment is semantically unchanged', async () => {
        const sharedPath = Uri.file('/opt/miniconda3/envs/shared').fsPath;
        refreshCondaEnvsStub.resolves([createMockPythonEnvironment({ name: 'shared', envPath: sharedPath, version: '3.9.0', id: 'shared-old' })]);
        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);
        refreshCondaEnvsStub.resolves([createMockPythonEnvironment({ name: 'shared', envPath: sharedPath, version: '3.9.0', id: 'shared-new' })]);
        await mgr.refresh(undefined);

        assert.deepStrictEqual(events, [], 'an unchanged same-path environment must not churn even when its id differs');
        const collection = (mgr as any).collection;
        assert.strictEqual(collection.length, 1, 'the single same-path entry is retained');
        assert.strictEqual(collection[0].version, '3.9.0', 'the collection holds the resolved env');
    });

    test('successful refresh emits exact remove then add when a same-path environment metadata changes', async () => {
        const sharedPath = Uri.file('/opt/miniconda3/envs/shared').fsPath;
        refreshCondaEnvsStub.resolves([createMockPythonEnvironment({ name: 'shared', envPath: sharedPath, version: '3.9.0', id: 'shared-old' })]);
        const mgr = createManager();
        await mgr.initialize();

        const events = collectEvents(mgr);
        refreshCondaEnvsStub.resolves([createMockPythonEnvironment({ name: 'shared', envPath: sharedPath, version: '3.10.0', id: 'shared-new' })]);
        await mgr.refresh(undefined);

        assert.deepStrictEqual(
            events.map((e) => `${e.kind}:${e.environment.name}:${e.environment.version}`),
            ['remove:shared:3.9.0', 'add:shared:3.10.0'],
            'a changed same-path environment emits exact remove then add',
        );
        const collection = (mgr as any).collection;
        assert.strictEqual(collection.length, 1, 'the changed entry replaces the old one');
        assert.strictEqual(collection[0].version, '3.10.0', 'the collection reflects the updated metadata');
    });

    function createManager(): CondaEnvManager {
        const api = {
            getPythonProjects: sinon.stub().returns([]),
            getPythonProject: sinon.stub().returns(undefined),
        } as any as PythonEnvironmentApi;
        return new CondaEnvManager(
            {} as NativePythonFinder,
            api,
            { info: sinon.stub(), error: sinon.stub(), warn: sinon.stub() } as any,
        );
    }

    function collectEvents(mgr: CondaEnvManager): any[] {
        const events: any[] = [];
        mgr.onDidChangeEnvironments((e) => events.push(...e));
        return events;
    }

    const base = () => makeEnv('base', Uri.file('/opt/miniconda3').fsPath, '3.12.0');
    const envB = () => makeEnv('envB', Uri.file('/opt/miniconda3/envs/envB').fsPath, '3.11.0');
});
