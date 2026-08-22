/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import { EnvironmentChangeKind, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as telemetrySender from '../../../common/telemetry/sender';
import * as windowApis from '../../../common/window.apis';
import * as commonUtils from '../../../managers/common/utils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { CondaEnvManager } from '../../../managers/conda/condaEnvManager';
import * as condaSourcingUtils from '../../../managers/conda/condaSourcingUtils';
import * as condaUtils from '../../../managers/conda/condaUtils';
import { makeMockCondaEnvironment as makeEnv } from '../../mocks/pythonEnvironment';

/**
 * Tests that CondaEnvManager preserves a known-good collection when discovery fails,
 * while still clearing stale environments on a genuine empty result.
 *
 * refreshCondaEnvs returns `undefined` on failure (native finder rejection / non-array
 * output) and a real array on success. The manager must not overwrite its collection or
 * emit environment changes on failure, but must remove stale environments when discovery
 * succeeds with an empty array.
 */
suite('CondaEnvManager - result preservation on discovery failure', () => {
    let getCondaStub: sinon.SinonStub;
    let refreshCondaEnvsStub: sinon.SinonStub;

    setup(() => {
        getCondaStub = sinon.stub(condaUtils, 'getConda').resolves('/usr/bin/conda');
        sinon.stub(condaUtils, 'getCondaPathSetting').returns(undefined);
        refreshCondaEnvsStub = sinon.stub(condaUtils, 'refreshCondaEnvs').resolves([]);
        sinon.stub(condaUtils, 'getCondaForGlobal').resolves(undefined);
        sinon.stub(condaUtils, 'getCondaForWorkspace').resolves(undefined);
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

    test('refresh preserves prior environments and emits no changes when discovery fails (undefined)', async () => {
        const known = [base(), envB()];
        refreshCondaEnvsStub.resolves(known);

        const mgr = createManager();
        await mgr.initialize();
        assert.strictEqual((await mgr.getEnvironments('all')).length, 2, 'precondition: two envs discovered');

        // Now a transient failure: refreshCondaEnvs reports failure via undefined.
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
        refreshCondaEnvsStub.resolves([]); // authoritative "no conda environments"
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

    test('initialize leaves the collection empty and emits no changes when discovery fails (undefined)', async () => {
        refreshCondaEnvsStub.resolves(undefined);

        const mgr = createManager();
        const events = collectEvents(mgr);
        await mgr.initialize();

        assert.strictEqual(getCondaStub.called, true, 'initialize still attempts discovery');
        assert.strictEqual(events.length, 0, 'a failed initial discovery must not emit environment changes');
        assert.strictEqual((await mgr.getEnvironments('all')).length, 0, 'no environments should be registered');
    });
});
