// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { Disposable, EventEmitter } from 'vscode';
import { PythonEnvironment } from '../../api';
import { AggregateEnvironmentError } from '../../common/errors/AggregateEnvironmentError';
import * as extensionApis from '../../common/extension.apis';
import * as logging from '../../common/logging';
import * as telemetrySender from '../../common/telemetry/sender';
import { PythonEnvironmentApiImpl } from '../../features/pythonApi';
import { _resetManagerReadyForTesting, createManagerReady } from '../../features/common/managerReady';
import * as settingHelpers from '../../features/settings/settingHelpers';
import {
    DidChangeEnvironmentManagerEventArgs,
    DidChangePackageManagerEventArgs,
    EnvironmentManagers,
    InternalEnvironmentManager,
} from '../../internal.api';

const DEFAULT_MANAGER_ID = 'ms-python.python:venv';

suite('PythonEnvironmentApiImpl - manager failure isolation', () => {
    let envManagerEmitter: EventEmitter<DidChangeEnvironmentManagerEventArgs>;
    let pkgManagerEmitter: EventEmitter<DidChangePackageManagerEventArgs>;
    let disposables: Disposable[];
    let traceErrorStub: sinon.SinonStub;
    let currentManagers: InternalEnvironmentManager[];
    let api: PythonEnvironmentApiImpl;

    setup(() => {
        disposables = [];
        currentManagers = [];
        _resetManagerReadyForTesting();

        envManagerEmitter = new EventEmitter<DidChangeEnvironmentManagerEventArgs>();
        pkgManagerEmitter = new EventEmitter<DidChangePackageManagerEventArgs>();

        traceErrorStub = sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceWarn');
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(extensionApis, 'getExtension').returns({
            id: 'ms-python.python',
            isActive: true,
        } as unknown as ReturnType<typeof extensionApis.getExtension>);
        sinon.stub(settingHelpers, 'getDefaultEnvManagerSetting').returns(DEFAULT_MANAGER_ID);
        sinon.stub(settingHelpers, 'getDefaultPkgManagerSetting').returns('ms-python.python:pip');

        const mockEm = {
            get managers() {
                return currentManagers;
            },
            onDidChangeActiveEnvironment: new EventEmitter().event,
            onDidChangeEnvironmentManager: envManagerEmitter.event,
            onDidChangePackageManager: pkgManagerEmitter.event,
        } as unknown as EnvironmentManagers;

        const mockPm = {
            getProjects: () => [],
            onDidChangeProjects: new EventEmitter().event,
        } as unknown as ConstructorParameters<typeof PythonEnvironmentApiImpl>[1];

        const mockEvm = {
            onDidChangeEnvironmentVariables: new EventEmitter().event,
        } as unknown as ConstructorParameters<typeof PythonEnvironmentApiImpl>[4];

        createManagerReady(mockEm, mockPm, disposables);
        envManagerEmitter.fire({
            kind: 'registered',
            manager: { id: DEFAULT_MANAGER_ID } as unknown as InternalEnvironmentManager,
        });

        api = new PythonEnvironmentApiImpl(
            mockEm,
            mockPm,
            {} as unknown as ConstructorParameters<typeof PythonEnvironmentApiImpl>[2],
            {} as unknown as ConstructorParameters<typeof PythonEnvironmentApiImpl>[3],
            mockEvm,
            disposables,
        );
    });

    teardown(() => {
        disposables.forEach((d) => d.dispose());
        envManagerEmitter.dispose();
        pkgManagerEmitter.dispose();
        sinon.restore();
        _resetManagerReadyForTesting();
    });

    suite('getEnvironments(all)', () => {
        test('partial success: one manager failing does not hide the others', async () => {
            const e1 = makeEnv('one');
            const e3 = makeEnv('three');
            const m2Error = new Error('m2 boom');
            currentManagers = [
                makeManager('m1', { envs: [e1] }),
                makeManager('m2', { getError: m2Error }),
                makeManager('m3', { envs: [e3] }),
            ];

            const result = await api.getEnvironments('all');

            assert.deepStrictEqual(
                result.map((e) => e.envId.id),
                ['one', 'three'],
                'should return successful managers only, in original order',
            );
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "m2" failed and was skipped.',
                m2Error,
            );
        });

        test('a manager throwing synchronously is isolated like an async rejection', async () => {
            const e1 = makeEnv('one');
            const e3 = makeEnv('three');
            const syncError = new Error('sync boom');
            const syncThrower = {
                id: 'm2',
                displayName: 'm2',
                getEnvironments: () => {
                    throw syncError;
                },
                refresh: async () => {},
            } as unknown as InternalEnvironmentManager;
            currentManagers = [makeManager('m1', { envs: [e1] }), syncThrower, makeManager('m3', { envs: [e3] })];

            const result = await api.getEnvironments('all');

            assert.deepStrictEqual(
                result.map((e) => e.envId.id),
                ['one', 'three'],
                'a synchronous throw must not hide the other managers results',
            );
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "m2" failed and was skipped.',
                syncError,
            );
        });

        test('results stay in original manager order even when a later manager resolves first', async () => {
            const e1 = makeEnv('one');
            const e2 = makeEnv('two');
            const e3 = makeEnv('three');
            currentManagers = [
                makeManager('m1', { envs: [e1], delayMs: 25 }),
                makeManager('m2', { envs: [e2], delayMs: 10 }),
                makeManager('m3', { envs: [e3], delayMs: 0 }),
            ];

            const result = await api.getEnvironments('all');

            assert.deepStrictEqual(
                result.map((e) => e.envId.id),
                ['one', 'two', 'three'],
                'flattened result must follow manager order, not completion order',
            );
        });

        test('total failure: throws AggregateEnvironmentError with all reasons in order', async () => {
            const err1 = new Error('first');
            const err2 = new Error('second');
            currentManagers = [
                makeManager('m1', { getError: err1 }),
                makeManager('m2', { getError: err2 }),
            ];

            await assert.rejects(
                () => api.getEnvironments('all'),
                (err: unknown) => {
                    assert.ok(err instanceof AggregateEnvironmentError, 'should throw AggregateEnvironmentError');
                    assert.deepStrictEqual(err.errors, [err1, err2], 'should carry all reasons in manager order');
                    return true;
                },
            );
            assert.strictEqual(traceErrorStub.callCount, 2, 'both failures should be logged exactly once');
            sinon.assert.calledWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "m1" failed and was skipped.',
                err1,
            );
            sinon.assert.calledWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "m2" failed and was skipped.',
                err2,
            );
        });

        test('a slow successful manager is awaited, not timed out, so a failing peer never rejects the caller or drops the slow result', async () => {
            const clock = sinon.useFakeTimers();
            const failing = new Error('boom');
            const slowEnv = makeEnv('slow-env');
            currentManagers = [
                makeManager('failing', { getError: failing }),
                makeManager('slow', { envs: [slowEnv], delayMs: 300_000 }),
            ];

            const resultPromise = api.getEnvironments('all');
            await clock.tickAsync(300_000);
            const result = await resultPromise;

            assert.deepStrictEqual(result, [slowEnv], 'the slow manager still contributes once its operation settles');
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "failing" failed and was skipped.',
                failing,
            );
        });

        test('a manager rejection is logged as soon as it settles even while another manager never settles', async () => {
            const clock = sinon.useFakeTimers();
            const failing = new Error('boom');
            const neverSettles = {
                id: 'pending',
                displayName: 'pending',
                getEnvironments: () => new Promise<PythonEnvironment[]>(() => {}),
                refresh: async () => {},
            } as unknown as InternalEnvironmentManager;
            currentManagers = [makeManager('failing', { getError: failing }), neverSettles];

            let settled = false;
            const resultPromise = api.getEnvironments('all');
            void resultPromise.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await clock.tickAsync(0);

            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(all)] Environment manager "failing" failed and was skipped.',
                failing,
            );
            assert.strictEqual(
                settled,
                false,
                'the aggregate stays pending while one manager never settles, yet the failure is already logged',
            );
        });

        test('empty manager list resolves with an empty array', async () => {
            currentManagers = [];
            const result = await api.getEnvironments('all');
            assert.deepStrictEqual(result, []);
            assert.ok(traceErrorStub.notCalled, 'no failures should be logged for an empty manager list');
        });
    });

    suite('getEnvironments(global)', () => {
        test('partial success: one manager failing does not hide the others, and the scope is forwarded', async () => {
            const globalEnv = makeEnv('global-one');
            const scopeAware = {
                id: 'm1',
                displayName: 'm1',
                getEnvironments: async (scope: unknown) => (scope === 'global' ? [globalEnv] : []),
                refresh: async () => {},
            } as unknown as InternalEnvironmentManager;
            const m2Error = new Error('m2 boom');
            currentManagers = [scopeAware, makeManager('m2', { getError: m2Error })];

            const result = await api.getEnvironments('global');

            assert.deepStrictEqual(
                result.map((e) => e.envId.id),
                ['global-one'],
                'global scope should return successful managers only and forward the scope',
            );
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(global)] Environment manager "m2" failed and was skipped.',
                m2Error,
            );
        });

        test('partial success where the only surviving manager has no environments resolves with [] (logged, not thrown)', async () => {
            const err = new Error('global-owner boom');
            currentManagers = [makeManager('m1', { getError: err }), makeManager('m2', { envs: [] })];

            const result = await api.getEnvironments('global');

            assert.deepStrictEqual(
                result,
                [],
                'a surviving manager with no environments yields an empty (not thrown) result',
            );
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[getEnvironments(global)] Environment manager "m1" failed and was skipped.',
                err,
            );
        });

        test('total failure: throws AggregateEnvironmentError with all reasons', async () => {
            const err1 = new Error('global-first');
            const err2 = new Error('global-second');
            currentManagers = [makeManager('m1', { getError: err1 }), makeManager('m2', { getError: err2 })];

            await assert.rejects(
                () => api.getEnvironments('global'),
                (err: unknown) => {
                    assert.ok(err instanceof AggregateEnvironmentError, 'should throw AggregateEnvironmentError');
                    assert.deepStrictEqual(err.errors, [err1, err2], 'should carry all reasons in manager order');
                    return true;
                },
            );
            assert.strictEqual(traceErrorStub.callCount, 2, 'both failures should be logged exactly once');
            sinon.assert.calledWithExactly(
                traceErrorStub,
                '[getEnvironments(global)] Environment manager "m1" failed and was skipped.',
                err1,
            );
            sinon.assert.calledWithExactly(
                traceErrorStub,
                '[getEnvironments(global)] Environment manager "m2" failed and was skipped.',
                err2,
            );
        });
    });

    suite('refreshEnvironments(undefined)', () => {
        test('partial success: completes even though one manager fails', async () => {
            let m3Refreshed = false;
            const m2Error = new Error('refresh boom');
            currentManagers = [
                makeManager('m1', {}),
                makeManager('m2', { refreshError: m2Error }),
                {
                    id: 'm3',
                    displayName: 'm3',
                    getEnvironments: async () => [],
                    refresh: async () => {
                        m3Refreshed = true;
                    },
                } as unknown as InternalEnvironmentManager,
            ];

            await api.refreshEnvironments(undefined);

            assert.ok(m3Refreshed, 'later managers still refresh despite an earlier failure');
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[refreshEnvironments(all)] Environment manager "m2" failed and was skipped.',
                m2Error,
            );
        });

        test('total failure: throws AggregateEnvironmentError with all reasons', async () => {
            const err1 = new Error('r1');
            const err2 = new Error('r2');
            currentManagers = [
                makeManager('m1', { refreshError: err1 }),
                makeManager('m2', { refreshError: err2 }),
            ];

            await assert.rejects(
                () => api.refreshEnvironments(undefined),
                (err: unknown) => {
                    assert.ok(err instanceof AggregateEnvironmentError);
                    assert.deepStrictEqual(err.errors, [err1, err2]);
                    return true;
                },
            );
        });

        test('a slow refresh is awaited to completion so its state mutation is never detached by a timeout', async () => {
            const clock = sinon.useFakeTimers();
            const failing = new Error('boom');
            let slowRefreshed = false;
            const slow = {
                id: 'slow',
                displayName: 'slow',
                getEnvironments: async () => [],
                refresh: async () => {
                    await delay(300_000);
                    slowRefreshed = true;
                },
            } as unknown as InternalEnvironmentManager;
            currentManagers = [makeManager('failing', { refreshError: failing }), slow];

            const resultPromise = api.refreshEnvironments(undefined);
            await clock.tickAsync(300_000);
            await resultPromise;

            assert.ok(slowRefreshed, 'the slow refresh runs to completion instead of being timed out and detached');
            sinon.assert.calledOnceWithExactly(
                traceErrorStub,
                '[refreshEnvironments(all)] Environment manager "failing" failed and was skipped.',
                failing,
            );
        });

        test('empty manager list completes without throwing', async () => {
            currentManagers = [];
            await api.refreshEnvironments(undefined);
            assert.ok(traceErrorStub.notCalled);
        });
    });
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeEnv(id: string): PythonEnvironment {
    return {
        envId: { id, managerId: 'test-manager' },
        name: id,
        displayName: id,
        displayPath: `/envs/${id}`,
    } as unknown as PythonEnvironment;
}

interface FakeManagerOptions {
    envs?: PythonEnvironment[];
    getError?: unknown;
    refreshError?: unknown;
    delayMs?: number;
}

function makeManager(id: string, options: FakeManagerOptions = {}): InternalEnvironmentManager {
    return {
        id,
        displayName: id,
        getEnvironments: async () => {
            if (options.delayMs) {
                await delay(options.delayMs);
            }
            if (options.getError !== undefined) {
                throw options.getError;
            }
            return options.envs ?? [];
        },
        refresh: async () => {
            if (options.delayMs) {
                await delay(options.delayMs);
            }
            if (options.refreshError !== undefined) {
                throw options.refreshError;
            }
        },
    } as unknown as InternalEnvironmentManager;
}
