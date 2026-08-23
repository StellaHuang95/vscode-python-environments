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
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

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

        assert.strictEqual((mgr as any)._initialized?.completed, true, 'initialization settles');

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
});
