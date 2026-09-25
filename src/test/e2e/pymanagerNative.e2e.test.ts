// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { ChildProcess } from 'child_process';
import * as path from 'path';
import * as sinon from 'sinon';
import { CancellationError, CancellationTokenSource, LogOutputChannel, Uri, window } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import * as processApis from '../../common/childProcess.apis';
import { normalizePath } from '../../common/utils/pathUtils';
import * as windowApis from '../../common/window.apis';
import * as installer from '../../managers/builtin/pythonInstaller';
import * as pymanager from '../../managers/builtin/pymanagerPythonInstaller';
import { PythonInstaller } from '../../managers/builtin/pythonInstallerTypes';
import { PymanagerCandidate, resolvePymanagerCandidate } from '../../managers/builtin/pythonRuntimeCandidates';
import * as uv from '../../managers/builtin/uvPythonInstaller';
import { waitForCondition } from '../testUtils';
import {
    activateInstallerApi,
    getInstallerFixtureRoot,
    PersistedInstallerFixture,
    readInstallerFixture,
    runFixturePython,
} from './pythonInstallerTestUtils';

interface NativeCall {
    readonly args: readonly string[];
    readonly child: ChildProcess;
    closed: boolean;
}

// These tests execute the compiled source modules with real native processes.
// Only UI answers, process observation and cancellation timing are controlled.
if (process.env.VSC_PYTHON_INSTALLER_E2E === '1' && process.env.VSC_PYTHON_INSTALLER_VERIFY_RELOAD !== '1') {
    suite('Installer E2E: native commands with controlled dialogs and cancellation', function () {
        this.timeout(180_000);
        let root: string;
        let fixture: PersistedInstallerFixture;
        let api: PythonEnvironmentApi;
        let base: PythonEnvironment;
        let provider: Extract<PythonInstaller, { kind: 'pymanager' }>;
        let candidate: PymanagerCandidate;
        let log: LogOutputChannel;
        let sandbox: sinon.SinonSandbox;
        let source: CancellationTokenSource;
        let calls: NativeCall[];
        let allowInstall: boolean;
        let observe: ((call: NativeCall) => void) | undefined;
        let errors: sinon.SinonStub;
        let uvFallback: sinon.SinonStub;

        suiteSetup(async () => {
            root = await getInstallerFixtureRoot();
            fixture = await readInstallerFixture(root);
            api = await activateInstallerApi();
            const resolved = await api.resolveEnvironment(Uri.file(fixture.pythonPath));
            assert.ok(resolved);
            assert.strictEqual(normalizePath(resolved.execInfo.run.executable), normalizePath(fixture.pythonPath));
            base = resolved;
            log = window.createOutputChannel('PyManager native scenario probes', { log: true });
            const detected = await pymanager.detectPymanager(log);
            assert.strictEqual(detected.kind, 'available');
            provider = { kind: 'pymanager', executable: detected.executable, configFile: path.join(root, 'pymanager.json') };
            const selected = await resolvePymanagerCandidate(
                provider.executable, { version: fixture.version }, log, undefined, provider.configFile,
            );
            assert.ok(selected, 'The already installed fixture release must remain available');
            candidate = selected;
        });

        suiteTeardown(() => log?.dispose());

        setup(async () => {
            sandbox = sinon.createSandbox();
            source = new CancellationTokenSource();
            calls = [];
            allowInstall = false;
            observe = undefined;
            const realSpawn = processApis.spawnProcess;
            sandbox.stub(processApis, 'spawnProcess').callsFake((executable, args, options) => {
                assert.strictEqual(process.env.PYTHON_MANAGER_CONFIG, provider.configFile);
                if (normalizePath(executable) === normalizePath(provider.executable)) {
                    if (args[0] === 'install') {
                        assert.ok(allowInstall, 'A non-mutating scenario must not install anything');
                        assert.deepStrictEqual(args, [
                            'install', '--config', provider.configFile, '--update', '--yes', candidate.installTag,
                        ], 'Only an idempotent install of the isolated fixture release is approved');
                    } else {
                        assert.strictEqual(args[0], 'list', 'Only read-only PyManager commands are allowed here');
                    }
                } else {
                    assert.strictEqual(normalizePath(executable), normalizePath(fixture.pythonPath));
                    assert.deepStrictEqual(args.slice(0, 3), ['-I', '-S', '-c']);
                }
                const child = realSpawn(executable, args, options);
                const call: NativeCall = { args: [...args], child, closed: false };
                calls.push(call);
                child.once('close', () => { call.closed = true; });
                observe?.(call);
                return child;
            });
            sandbox.stub(windowApis, 'showInformationMessage').callsFake(async () => {
                throw new Error('Unexpected installation consent in a non-mutating scenario');
            });
            errors = sandbox.stub(windowApis, 'showErrorMessage').resolves(undefined);
            sandbox.stub(windowApis, 'withProgress').callsFake(async (_options, action) =>
                action({ report: () => undefined }, source.token));
            uvFallback = sandbox.stub(uv, 'promptInstallPythonViaUvDetailed').callsFake(async () => {
                throw new Error('Unexpected uv fallback');
            });
            await getInstallerFixtureRoot();
        });

        teardown(async () => {
            try {
                const unclosed = calls.filter((call) => !call.closed);
                source.cancel();
                for (const call of unclosed) {
                    call.child.kill();
                }
                await waitForCondition(() => calls.every((call) => call.closed), 5000, 'A native scenario child remained open');
                assert.strictEqual(unclosed.length, 0, 'The scenario must await every native child before completing');
                sinon.assert.notCalled(errors);
                sinon.assert.notCalled(uvFallback);
            } finally {
                source.dispose();
                sandbox.restore();
            }
        });

        function installCalls(): NativeCall[] {
            return calls.filter((call) => call.args[0] === 'install');
        }

        async function assertBasePreserved(): Promise<void> {
            const version = await runFixturePython(api, root, base, ['-I', '-c', 'import platform; print(platform.python_version())']);
            assert.strictEqual(version.trim(), fixture.version);
        }

        test('reuses a verified runtime without consent or an install command', async () => {
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, { version: fixture.version });
            assert.strictEqual(result.kind, 'installed');
            assert.strictEqual(result.provider, 'pymanager');
            assert.strictEqual(normalizePath(result.pythonPath), normalizePath(fixture.pythonPath));
            assert.strictEqual(installCalls().length, 0);
        });

        test('serializes simultaneous acquisition requests and reuses the same base', async () => {
            const results = await Promise.all([
                installer.promptInstallPythonDetailed('inlineScript', log, { version: fixture.version }),
                installer.promptInstallPythonDetailed('inlineScript', log, { requiresPython: `>=${fixture.version}` }),
            ]);
            for (const result of results) {
                assert.strictEqual(result.kind, 'installed');
                assert.strictEqual(normalizePath(result.pythonPath), normalizePath(fixture.pythonPath));
            }
            assert.strictEqual(installCalls().length, 0);
        });

        test('loads the real Global catalogue and cancels the picker without installing', async () => {
            const picker = sandbox.stub(windowApis, 'showQuickPick').callsFake(async (items) => {
                const choices = await items;
                assert.ok(choices.length > 0, 'The native catalogue should offer eligible versions');
                return undefined;
            });
            assert.strictEqual(await installer.selectAndInstallPython(log), undefined);
            sinon.assert.calledOnce(picker);
            assert.ok(calls.some((call) => call.args.includes('--online')));
            assert.strictEqual(installCalls().length, 0);
        });

        test('rejects an unavailable exact release without native mutation or uv fallback', async () => {
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, { version: '3.99.99' });
            assert.strictEqual(result.kind, 'failed');
            assert.strictEqual(result.reason, 'no-compatible-python');
            assert.strictEqual(installCalls().length, 0);
        });

        test('rejects an exact older patch in the already newer slot', async () => {
            const [major, minor, patch] = fixture.version.split('.').map(Number);
            assert.ok(patch > 0);
            const result = await installer.promptInstallPythonDetailed('inlineScript', log, {
                version: `${major}.${minor}.${patch - 1}`,
            });
            assert.strictEqual(result.kind, 'failed');
            assert.strictEqual(result.reason, 'runtime-conflict');
            assert.strictEqual(installCalls().length, 0);
        });

        test('cancellation before preflight starts no native process', async () => {
            source.cancel();
            await assert.rejects(
                installer.installApprovedPymanagerRuntime(provider, candidate, { version: fixture.version }, log, source.token),
                (error: unknown) => error instanceof CancellationError,
            );
            assert.strictEqual(calls.length, 0);
        });

        for (const stage of ['preflight', 'postflight', 'verification'] as const) {
            test(`cancels the real ${stage} process and preserves the installed runtime`, async () => {
                allowInstall = stage !== 'preflight';
                let lists = 0;
                let cancelledAt: number | undefined;
                observe = (call) => {
                    if (call.args[0] === 'list') {
                        lists += 1;
                    }
                    const shouldCancel = stage === 'preflight'
                        ? call.args[0] === 'list' && lists === 1
                        : stage === 'postflight'
                          ? call.args[0] === 'list' && lists === 2
                          : call.args[0] === '-I';
                    if (shouldCancel) {
                        call.child.once('spawn', () => {
                            cancelledAt = Date.now();
                            source.cancel();
                        });
                    }
                };
                await assert.rejects(
                    installer.installApprovedPymanagerRuntime(provider, candidate, { version: fixture.version }, log, source.token),
                    (error: unknown) => error instanceof CancellationError,
                );
                assert.ok(cancelledAt !== undefined, 'The requested native stage must actually start');
                assert.ok(Date.now() - cancelledAt < 5000, 'Cancellation must not wait for the inventory timeout');
                assert.ok(calls.every((call) => call.closed));
                assert.strictEqual(installCalls().length, stage === 'preflight' ? 0 : 1);
                assert.strictEqual(lists, stage === 'preflight' ? 1 : 2);
                await assertBasePreserved();
            });
        }

        test('cancellation at install completion prevents the next inventory command', async () => {
            allowInstall = true;
            observe = (call) => {
                if (call.args[0] === 'install') {
                    call.child.once('close', () => source.cancel());
                }
            };
            await assert.rejects(
                installer.installApprovedPymanagerRuntime(provider, candidate, { version: fixture.version }, log, source.token),
                (error: unknown) => error instanceof CancellationError,
            );
            assert.strictEqual(calls.filter((call) => call.args[0] === 'list').length, 1);
            assert.strictEqual(installCalls().length, 1);
            assert.ok(calls.every((call) => call.args[0] !== '-I'));
            await assertBasePreserved();
        });
    });
}
