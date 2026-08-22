/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as sinon from 'sinon';
import { LogOutputChannel } from 'vscode';
import { EnvironmentManager, PythonEnvironmentApi } from '../../../api';
import * as logging from '../../../common/logging';
import * as persistentState from '../../../common/persistentState';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { refreshCondaEnvs } from '../../../managers/conda/condaUtils';

/**
 * Unit tests for the failure-vs-empty contract of refreshCondaEnvs.
 *
 * The utility must return `undefined` when discovery fails (native finder rejects or
 * returns non-array data) and a real array (including `[]`) when discovery succeeds.
 * Callers rely on this distinction to avoid deleting known-good environments after a
 * transient failure while still clearing stale environments on a genuine empty result.
 */
suite('condaUtils.refreshCondaEnvs - failure vs. successful-empty contract', () => {
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

        // Avoid touching real persistent state when the successful-empty path reaches getConda().
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

    test('returns undefined when the native finder resolves null (non-array)', async () => {
        nativeFinder.refresh.resolves(null as any);

        const result = await refreshCondaEnvs(
            false,
            nativeFinder as unknown as NativePythonFinder,
            api,
            log,
            manager,
        );

        assert.strictEqual(result, undefined, 'null output must be reported as failure (undefined)');
    });

    test('returns undefined when the native finder resolves a non-array object', async () => {
        nativeFinder.refresh.resolves({ not: 'an array' } as any);

        const result = await refreshCondaEnvs(
            false,
            nativeFinder as unknown as NativePythonFinder,
            api,
            log,
            manager,
        );

        assert.strictEqual(result, undefined, 'malformed output must be reported as failure (undefined)');
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
