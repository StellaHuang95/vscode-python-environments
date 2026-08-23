/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { refreshCondaEnvs } from '../../../managers/conda/condaUtils';

suite('condaUtils.refreshCondaEnvs - failure vs. successful contract', () => {
    let nativeFinder: { refresh: sinon.SinonStub };
    let api: PythonEnvironmentApi;
    let log: LogOutputChannel;
    let manager: EnvironmentManager;

    setup(() => {
        nativeFinder = { refresh: sinon.stub() };
        api = {} as PythonEnvironmentApi;
        log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } as unknown as LogOutputChannel;
        manager = {} as EnvironmentManager;

        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceVerbose');

        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves({
            get: sinon.stub().resolves(undefined),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        } as any);
    });

    teardown(() => {
        sinon.restore();
    });

    test('returns undefined when the native finder rejects (discovery failure)', async () => {
        nativeFinder.refresh.rejects(new Error('native finder boom'));

        const result = await refreshCondaEnvs(
            true,
            nativeFinder as unknown as NativePythonFinder,
            api,
            log,
            manager,
        );

        assert.strictEqual(result, undefined, 'a rejected refresh must be reported as failure (undefined)');
    });

    test('returns an empty array (not undefined) on a successful discovery with no conda envs', async () => {
        nativeFinder.refresh.resolves([]);

        const result = await refreshCondaEnvs(
            false,
            nativeFinder as unknown as NativePythonFinder,
            api,
            log,
            manager,
        );

        assert.ok(Array.isArray(result), 'a successful empty discovery must return an array, not undefined');
        assert.strictEqual(result!.length, 0, 'a successful empty discovery must return an empty array');
    });
});
