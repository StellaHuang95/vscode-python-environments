// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, LogOutputChannel, TextDocument, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment, PythonEnvironmentApi } from '../../../../api';
import * as cacheKey from '../../../../common/inlineScript/cacheKey';
import * as cacheLayout from '../../../../common/inlineScript/cacheLayout';
import * as metadataReader from '../../../../common/inlineScript/metadata';
import { InlineScriptRoutingRegistry } from '../../../../common/inlineScript/routingRegistry';
import * as lockfileApis from '../../../../common/lockfile.apis';
import * as persistentState from '../../../../common/persistentState';
import { isWindows } from '../../../../common/utils/platformUtils';
import { normalizePath } from '../../../../common/utils/pathUtils';
import { getVenvPythonPath } from '../../../../common/utils/virtualEnvironment';
import * as workspaceApis from '../../../../common/workspace.apis';
import {
    InlineScriptEnvManager,
    INLINE_SCRIPT_ENVS_KEY,
} from '../../../../managers/builtin/inlineScript/envManager';
import * as builtinUtils from '../../../../managers/builtin/utils';
import * as uvPythonInstaller from '../../../../managers/builtin/uvPythonInstaller';
import * as venvUtils from '../../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../../managers/common/nativePythonFinder';

const CACHE_KEY = '0123456789abcdef';
const NOW = new Date('2026-07-21T12:00:00.000Z');
const VALID_METADATA: metadataReader.InlineScriptMetadata = {
    requiresPython: '>=3.11',
    dependencies: ['requests'],
    range: { start: 0, end: 40 },
};
const VALID_METADATA_IDENTITY = JSON.stringify({
    requiresPython: '>=3.11',
    dependencies: ['requests'],
});

function makeFakeLog(): LogOutputChannel {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        trace: sinon.stub(),
        show: sinon.stub(),
        dispose: sinon.stub(),
        append: sinon.stub(),
        appendLine: sinon.stub(),
        replace: sinon.stub(),
        clear: sinon.stub(),
        hide: sinon.stub(),
    } as unknown as LogOutputChannel;
}

function makeEnvironment(
    managerId: string,
    version: string,
    executable: string,
    sysPrefix: string = path.dirname(executable),
    name: string = `Python ${version}`,
): PythonEnvironment {
    return {
        envId: { id: `${managerId}-${version}-${executable}`, managerId },
        name,
        displayName: `Python ${version}`,
        displayPath: executable,
        version,
        environmentPath: Uri.file(executable),
        execInfo: { run: { executable } },
        sysPrefix,
    };
}

function makeUvPythonVersion(version: string): uvPythonInstaller.UvPythonVersion {
    const [major, minor, patch] = version.match(/\d+/g)!.map(Number);
    return {
        key: `cpython-${version}`,
        version,
        version_parts: { major, minor, patch },
        path: null,
        url: null,
        os: 'windows',
        variant: 'default',
        implementation: 'cpython',
        arch: 'x86_64',
    };
}

const venvPythonPath = getVenvPythonPath;

suite('InlineScriptEnvManager', () => {
    let api: PythonEnvironmentApi;
    let apiGetEnvironmentsStub: sinon.SinonStub;
    let apiRefreshEnvironmentsStub: sinon.SinonStub;
    let baseEnvironment: PythonEnvironment;
    let baseExecutable: string;
    let baseManager: EnvironmentManager;
    let computeCacheKeyStub: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    let createWithProgressStub: sinon.SinonStub;
    let getAvailablePythonVersionsStub: sinon.SinonStub;
    let ensureUvForVersionLookupStub: sinon.SinonStub;
    let globalStorageUri: Uri;
    let lockStub: sinon.SinonStub;
    let manager: InlineScriptEnvManager;
    let nativeFinder: NativePythonFinder;
    let promptInstallPythonViaUvStub: sinon.SinonStub;
    let readMetadataStub: sinon.SinonStub;
    let inspectMetaStub: sinon.SinonStub;
    let retainLockStub: sinon.SinonStub;
    let releaseLockStub: sinon.SinonStub;
    let resolveSystemPythonStub: sinon.SinonStub;
    let resolveVenvStub: sinon.SinonStub;
    let routingRegistry: InlineScriptRoutingRegistry;
    let sidecarsByEnvDir: Map<string, cacheLayout.InlineScriptEnvMeta | 'missing' | 'invalid' | 'unavailable'>;
    let environmentsByExecutablePath: Map<string, PythonEnvironment>;
    let cacheKeysByInputs: Map<string, string>;
    let tempRoot: string;
    let baseInterpreterStatusStub: sinon.SinonStub;
    let writeMetaStub: sinon.SinonStub;
    let deleteFilesListener: ((e: { files: readonly Uri[] }) => unknown) | undefined;
    let renameFilesListener: ((e: { files: readonly { oldUri: Uri; newUri: Uri }[] }) => unknown) | undefined;
    let workspaceState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };
    let persistedAssociations: unknown;

    setup(async () => {
        tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'inline-script-manager-')));
        globalStorageUri = Uri.file(path.join(tempRoot, 'global-storage'));
        baseExecutable = path.join(tempRoot, 'base-python', isWindows() ? 'python.exe' : 'python');
        await fs.outputFile(baseExecutable, '');
        baseEnvironment = makeEnvironment('ms-python.python:system', '3.12.4', baseExecutable);

        apiGetEnvironmentsStub = sinon.stub().resolves([baseEnvironment]);
        apiRefreshEnvironmentsStub = sinon.stub().resolves();
        api = {
            getEnvironments: apiGetEnvironmentsStub,
            refreshEnvironments: apiRefreshEnvironmentsStub,
        } as unknown as PythonEnvironmentApi;
        nativeFinder = {} as NativePythonFinder;
        routingRegistry = new InlineScriptRoutingRegistry();
        sidecarsByEnvDir = new Map();
        environmentsByExecutablePath = new Map();
        cacheKeysByInputs = new Map();
        deleteFilesListener = undefined;
        renameFilesListener = undefined;
        baseManager = {} as EnvironmentManager;
        persistedAssociations = undefined;
        workspaceState = {
            get: sinon.stub().callsFake(async (key: string) => {
                return key === INLINE_SCRIPT_ENVS_KEY ? persistedAssociations : undefined;
            }),
            set: sinon.stub().callsFake(async (key: string, value: unknown) => {
                if (key === INLINE_SCRIPT_ENVS_KEY) {
                    persistedAssociations = value;
                }
            }),
            clear: sinon.stub(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(workspaceState);

        readMetadataStub = sinon.stub(metadataReader, 'readInlineScriptMetadataFromFile').resolves(VALID_METADATA);
        computeCacheKeyStub = sinon.stub(cacheKey, 'computeCacheKey').callsFake((inputs) => {
            return cacheKeysByInputs.get(getCacheKeyInputKey(inputs.dependencies, inputs.interpreterPath)) ?? CACHE_KEY;
        });
        registerCacheKey(CACHE_KEY, VALID_METADATA.dependencies ?? [], baseExecutable);
        getAvailablePythonVersionsStub = sinon.stub(uvPythonInstaller, 'getAvailablePythonVersions').resolves([]);
        ensureUvForVersionLookupStub = sinon
            .stub(uvPythonInstaller, 'ensureUvForInlineScriptVersionLookup')
            .resolves(true);
        promptInstallPythonViaUvStub = sinon.stub(uvPythonInstaller, 'promptInstallPythonViaUv');
        inspectMetaStub = sinon.stub(cacheLayout, 'inspectMetaJson').callsFake(async (envDir: Uri) => {
            const result = sidecarsByEnvDir.get(normalizePath(envDir.fsPath)) ?? 'missing';
            if (result === 'missing' || result === 'invalid' || result === 'unavailable') {
                return { kind: result };
            }
            return { kind: 'valid', metadata: result };
        });
        baseInterpreterStatusStub = sinon.stub(cacheLayout, 'getBaseInterpreterStatus').resolves('available');
        writeMetaStub = sinon.stub(cacheLayout, 'writeMetaJson').callsFake(async (envDir: Uri, meta: cacheLayout.InlineScriptEnvMeta) => {
            sidecarsByEnvDir.set(normalizePath(envDir.fsPath), meta);
        });
        retainLockStub = sinon.stub().resolves();
        releaseLockStub = sinon.stub().resolves();
        lockStub = sinon
            .stub(lockfileApis, 'acquireFileLock')
            .resolves({ release: releaseLockStub, retain: retainLockStub });
        resolveSystemPythonStub = sinon.stub(builtinUtils, 'resolveSystemPythonEnvironmentPath').resolves(undefined);
        resolveVenvStub = sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').callsFake(async (environmentPath: string) => {
            return environmentsByExecutablePath.get(normalizePath(environmentPath));
        });
        sinon.stub(workspaceApis, 'onDidDeleteFiles').callsFake((listener: (e: { files: readonly Uri[] }) => unknown) => {
            deleteFilesListener = listener;
            return new Disposable(() => {
                deleteFilesListener = undefined;
            });
        });
        sinon
            .stub(workspaceApis, 'onDidRenameFiles')
            .callsFake((listener: (e: { files: readonly { oldUri: Uri; newUri: Uri }[] }) => unknown) => {
                renameFilesListener = listener;
                return new Disposable(() => {
                    renameFilesListener = undefined;
                });
            });
        sinon.stub(workspaceApis, 'getOpenTextDocuments').returns([]);
        createWithProgressStub = sinon.stub(venvUtils, 'createWithProgress').callsFake(async (...args: unknown[]) => {
            const envDir = args[6] as string;
            const selectedBase = args[4] as PythonEnvironment;
            await fs.outputFile(getVenvPythonPath(envDir), '');
            const environment = makeEnvironment(
                'ms-python.python:inline-script',
                selectedBase.version,
                getVenvPythonPath(envDir),
                envDir,
            );
            environmentsByExecutablePath.set(normalizePath(environment.environmentPath.fsPath), environment);
            return {
                environment,
            };
        });

        clock = sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
        manager = new InlineScriptEnvManager(
            nativeFinder,
            api,
            baseManager,
            globalStorageUri,
            makeFakeLog(),
            routingRegistry,
        );
    });

    teardown(async () => {
        manager.dispose();
        sinon.restore();
        await fs.remove(tempRoot);
    });

    function scriptUri(name = 'script.py'): Uri {
        return Uri.file(path.join(tempRoot, name));
    }

    function envDir(): Uri {
        return cacheLayout.getScriptEnvDir(globalStorageUri, CACHE_KEY);
    }

    function getCacheKeyInputKey(dependencies: readonly string[], interpreterPath: string): string {
        return JSON.stringify({
            dependencies: Array.from(
                new Set(dependencies.map((dependency) => cacheKey.normalizeDependency(dependency)).filter(Boolean)),
            ).sort(),
            interpreterPath: normalizePath(interpreterPath),
        });
    }

    function registerCacheKey(cacheKeyValue: string, dependencies: readonly string[], interpreterPath: string): void {
        cacheKeysByInputs.set(getCacheKeyInputKey(dependencies, interpreterPath), cacheKeyValue);
    }

    function setSidecar(metadata: cacheLayout.InlineScriptEnvMeta, targetEnvDir: Uri = envDir()): void {
        sidecarsByEnvDir.set(normalizePath(targetEnvDir.fsPath), metadata);
    }

    async function createOwnedEnvironment(
        cacheKey: string = CACHE_KEY,
        envId: string = `inline-${cacheKey}`,
    ): Promise<PythonEnvironment> {
        const location = cacheLayout.getScriptEnvDir(globalStorageUri, cacheKey).fsPath;
        const executable = getVenvPythonPath(location);
        const baseInterpreterPath =
            cacheKey === CACHE_KEY
                ? baseExecutable
                : path.join(tempRoot, `base-python-${cacheKey}`, isWindows() ? 'python.exe' : 'python');
        await fs.outputFile(baseInterpreterPath, '');
        await fs.outputFile(executable, '');
        registerCacheKey(cacheKey, VALID_METADATA.dependencies ?? [], baseInterpreterPath);
        setSidecar({
            schemaVersion: cacheLayout.META_SCHEMA_VERSION,
            baseInterpreterPath,
            baseInterpreterVersion: baseEnvironment.version,
            lastUsedAt: NOW.toISOString(),
        }, Uri.file(location));
        const environment = {
            ...makeEnvironment('ms-python.python:inline-script', '3.12.4', executable, location),
            envId: { managerId: 'ms-python.python:inline-script', id: envId },
        };
        environmentsByExecutablePath.set(normalizePath(executable), environment);
        return environment;
    }

    async function waitForStubCall(stub: sinon.SinonStub): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (stub.called) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail('Expected the stub to be called');
    }

    async function waitForStubCallCount(stub: { callCount: number }, count: number): Promise<void> {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (stub.callCount >= count) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail(`Expected the stub to be called at least ${count} times`);
    }

    function nextTurn(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    function fireDelete(...files: Uri[]): void {
        assert.ok(deleteFilesListener, 'delete listener should be registered');
        deleteFilesListener!({ files });
    }

    function fireRename(oldUri: Uri, newUri: Uri): void {
        assert.ok(renameFilesListener, 'rename listener should be registered');
        renameFilesListener!({ files: [{ oldUri, newUri }] });
    }

    function workspaceStateSetCalls(key: string): readonly sinon.SinonSpyCall[] {
        return workspaceState.set.getCalls().filter((call) => call.args[0] === key);
    }

    function matchedAssociationRecord(environmentPath: string, metadataIdentity: string = VALID_METADATA_IDENTITY): unknown {
        return {
            schemaVersion: 1,
            environmentPath,
            metadataBinding: {
                kind: 'matched',
                sourceIdentity: metadataIdentity,
            },
        };
    }

    function pendingAssociationRecord(environmentPath: string, metadataIdentity: string = VALID_METADATA_IDENTITY): unknown {
        return {
            schemaVersion: 1,
            environmentPath,
            metadataBinding: {
                kind: 'pending',
                sourceIdentity: metadataIdentity,
            },
        };
    }

    function futureAssociationRecord(environmentPath: string): unknown {
        return {
            schemaVersion: 2,
            environmentPath,
            metadataBinding: {
                kind: 'matched',
                sourceIdentity: 'future',
            },
        };
    }

    async function triggerSavedMetadataChange(
        registry: InlineScriptRoutingRegistry,
        managerInstance: InlineScriptEnvManager,
        uri: Uri,
        metadata: metadataReader.InlineScriptMetadata = VALID_METADATA,
    ): Promise<void> {
        registry.setMetadata(uri, metadata);
        await (
            managerInstance as unknown as {
                handleSavedMetadataChange(event: {
                    uri: Uri;
                    metadata: metadataReader.InlineScriptMetadata;
                    metadataIdentity: string | undefined;
                    metadataRevision: number;
                }): Promise<void>;
            }
        ).handleSavedMetadataChange({
            uri,
            metadata,
            metadataIdentity: registry.getMetadataIdentity(uri),
            metadataRevision: registry.getMetadataRevision(uri),
        });
    }

    function asMetadataRefreshManager(managerInstance: InlineScriptEnvManager): {
        refreshValidatedAssociationForMetadataInternal(
            scriptPath: string,
            uri: Uri,
            metadata: metadataReader.InlineScriptMetadata,
            metadataIdentity: string,
            metadataRevision: number,
            associationRevision: number,
        ): Promise<void>;
        currentCacheEntryProvesSourceMetadataIdentity(
            candidate: PythonEnvironment,
            metadataIdentity: string,
            metadata: metadataReader.InlineScriptMetadata,
        ): Promise<boolean>;
        cachedAssociationValidatedAt: Map<string, number>;
        lastValidatedMetadataIdentities: Map<string, string>;
        lastValidatedMetadataIdentityProofs: Map<string, boolean>;
        associationRevisions: Map<string, number>;
        subscriptions: Disposable[];
    } {
        return managerInstance as unknown as {
            refreshValidatedAssociationForMetadataInternal(
                scriptPath: string,
                uri: Uri,
                metadata: metadataReader.InlineScriptMetadata,
                metadataIdentity: string,
                metadataRevision: number,
                associationRevision: number,
            ): Promise<void>;
            currentCacheEntryProvesSourceMetadataIdentity(
                candidate: PythonEnvironment,
                metadataIdentity: string,
                metadata: metadataReader.InlineScriptMetadata,
            ): Promise<boolean>;
            cachedAssociationValidatedAt: Map<string, number>;
            lastValidatedMetadataIdentities: Map<string, string>;
            lastValidatedMetadataIdentityProofs: Map<string, boolean>;
            associationRevisions: Map<string, number>;
            subscriptions: Disposable[];
        };
    }

    suite('static metadata and deferred methods', () => {
        test('exposes creation but leaves later-phase methods empty', async () => {
            const asInterface: EnvironmentManager = manager;
            assert.strictEqual(typeof asInterface.create, 'function');
            assert.strictEqual(asInterface.remove, undefined);
            assert.strictEqual(asInterface.quickCreateConfig, undefined);
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(await manager.get(scriptUri()), undefined);
            assert.strictEqual(await manager.resolve(scriptUri()), undefined);
        });

        test('retains inline-script manager presentation metadata', () => {
            assert.strictEqual(manager.name, 'inline-script');
            assert.ok(manager.displayName);
            assert.strictEqual(manager.preferredPackageManagerId, 'ms-python.python:pip');
            assert.ok(manager.iconPath);
            assert.ok(manager.tooltip);
        });
    });

    suite('scope and metadata validation', () => {
        test('rejects global, empty, multiple, and non-file scopes without reading metadata', async () => {
            assert.strictEqual(await manager.create('global'), undefined);
            assert.strictEqual(await manager.create([]), undefined);
            assert.strictEqual(await manager.create([scriptUri('a.py'), scriptUri('b.py')]), undefined);
            assert.strictEqual(await manager.create(Uri.parse('untitled:script.py')), undefined);
            assert.strictEqual(readMetadataStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('accepts a singleton URI array', async () => {
            const uri = scriptUri();
            const result = await manager.create([uri]);
            assert.ok(result);
            assert.ok(readMetadataStub.calledOnceWithExactly(uri));
        });

        test('returns undefined without cache mutation when metadata is absent', async () => {
            readMetadataStub.resolves(undefined);
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('rejects empty dependency entries before selecting or locking', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, dependencies: ['requests', '   '] });
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });
    });

    suite('base interpreter selection', () => {
        test('excludes derived managers even when they report newer global environments', async () => {
            const pipenv = makeEnvironment('ms-python.python:pipenv', '3.14.0', baseExecutable);
            apiGetEnvironmentsStub.resolves([pipenv, baseEnvironment]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('does not reapply release-only matching after strict PEP 440 filtering', async () => {
            const finalRelease = makeEnvironment('ms-python.python:system', '3.15.0', baseExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '!=3.15.0rc2' });
            apiGetEnvironmentsStub.resolves([finalRelease]);

            assert.ok(await manager.create(scriptUri()));

            assert.strictEqual(createWithProgressStub.firstCall.args[4], finalRelease);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
        });

        test('excludes named conda environments even when they are newer than conda base', async () => {
            const condaNamed = makeEnvironment(
                'ms-python.python:conda',
                '3.14.0',
                baseExecutable,
                undefined,
                'project-env',
            );
            const condaBase = makeEnvironment(
                'ms-python.python:conda',
                '3.11.9',
                baseExecutable,
                undefined,
                'base',
            );
            apiGetEnvironmentsStub.resolves([condaNamed, condaBase]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], condaBase);
        });

        test('falls back when the newest compatible interpreter cannot be canonicalized', async () => {
            const missingExecutable = path.join(tempRoot, 'missing', 'python');
            const newest = makeEnvironment('ms-python.python:system', '3.13.0', missingExecutable);
            apiGetEnvironmentsStub.resolves([baseEnvironment, newest]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('excludes pyenv virtual environments reported in global scope', async () => {
            const pyenvVenvRoot = path.join(tempRoot, 'pyenv', 'versions', 'project-env');
            const pyenvVenvExecutable = venvPythonPath(pyenvVenvRoot);
            await fs.outputFile(pyenvVenvExecutable, '');
            await fs.outputFile(path.join(pyenvVenvRoot, 'pyvenv.cfg'), 'home = base');
            const pyenvVenv = makeEnvironment(
                'ms-python.python:pyenv',
                '3.13.0',
                pyenvVenvExecutable,
                pyenvVenvRoot,
            );
            apiGetEnvironmentsStub.resolves([pyenvVenv, baseEnvironment]);

            await manager.create(scriptUri());

            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
        });

        test('does not invoke creation when no installed base satisfies requires-python', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('skips base records with empty or relative sysPrefix values', async () => {
            const emptyPrefixExecutable = path.join(tempRoot, 'empty-prefix-python');
            const relativePrefixExecutable = path.join(tempRoot, 'relative-prefix-python');
            await fs.outputFile(emptyPrefixExecutable, '');
            await fs.outputFile(relativePrefixExecutable, '');
            apiGetEnvironmentsStub.resolves([
                makeEnvironment('ms-python.python:system', '3.14.0', emptyPrefixExecutable, ''),
                makeEnvironment('ms-python.python:system', '3.13.0', relativePrefixExecutable, 'relative-prefix'),
                baseEnvironment,
            ]);

            assert.ok(await manager.create(scriptUri()));
            sinon.assert.calledWith(computeCacheKeyStub, {
                dependencies: ['requests'],
                interpreterPath: await fs.realpath(baseExecutable),
            });
        });
    });

    suite('uv base interpreter fallback', () => {
        test('installs the requirement lower bound, refreshes, and uses the discovered base interpreter', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13',
                version: '3.13',
            });
            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 3);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
        });

        test('asks uv for the latest Python when requires-python is absent', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.14.0', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: undefined });
            apiGetEnvironmentsStub.onFirstCall().resolves([]);
            apiGetEnvironmentsStub.onSecondCall().resolves([]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: undefined,
                version: undefined,
            });
            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            assert.strictEqual(apiGetEnvironmentsStub.callCount, 3);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
        });

        test('does not mutate the cache when the user declines installation', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            promptInstallPythonViaUvStub.resolves(undefined);

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(await fs.pathExists(cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath), false);
        });

        test('does not mutate the cache when installation fails', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            promptInstallPythonViaUvStub.rejects(new Error('uv failed'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('directly resolves the installed interpreter when environment refresh fails', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);
            apiRefreshEnvironmentsStub.rejects(new Error('discovery failed'));
            resolveSystemPythonStub.resolves(uvBase);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
            sinon.assert.calledOnceWithExactly(
                resolveSystemPythonStub,
                uvExecutable,
                nativeFinder,
                api,
                baseManager,
            );
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('directly resolves the installed interpreter when post-install discovery fails', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().rejects(new Error('discovery failed'));
            promptInstallPythonViaUvStub.resolves(uvExecutable);
            resolveSystemPythonStub.resolves(uvBase);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(
                resolveSystemPythonStub,
                uvExecutable,
                nativeFinder,
                api,
                baseManager,
            );
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('selects an available uv release that satisfies exclusion clauses', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.3', uvExecutable);
            readMetadataStub.resolves({
                ...VALID_METADATA,
                requiresPython: '>=3.13.2,!=3.13.2',
            });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                {
                    key: 'cpython-3.13.2',
                    version: '3.13.2',
                    version_parts: { major: 3, minor: 13, patch: 2 },
                    path: null,
                    url: null,
                    os: 'windows',
                    variant: 'default',
                    implementation: 'cpython',
                    arch: 'x86_64',
                },
                {
                    key: 'cpython-3.13.3',
                    version: '3.13.3',
                    version_parts: { major: 3, minor: 13, patch: 3 },
                    path: null,
                    url: null,
                    os: 'windows',
                    variant: 'default',
                    implementation: 'cpython',
                    arch: 'x86_64',
                },
            ]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13.2,!=3.13.2',
                version: '3.13.3',
            });
            assert.strictEqual(createWithProgressStub.firstCall.args[4], uvBase);
            sinon.assert.calledOnceWithExactly(
                ensureUvForVersionLookupStub,
                '>=3.13.2,!=3.13.2',
                manager.log,
            );
        });

        test('uses an explicit patch release when a minor selector could exceed the constraint', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.0', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13,<=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                makeUvPythonVersion('3.13.3'),
                makeUvPythonVersion('3.13.0'),
            ]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.13,<=3.13',
                version: '3.13.0',
            });
        });

        test('uses an advertised release for a bounded range instead of fabricating patch zero', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.11.14', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.11,<3.12' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([makeUvPythonVersion('3.11.14')]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.11,<3.12',
                version: '3.11.14',
            });
        });

        test('uses an exact requirement without needing an existing uv catalog', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.13.1' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '==3.13.1',
                version: '3.13.1',
            });
            assert.strictEqual(getAvailablePythonVersionsStub.callCount, 0);
        });

        test('does not select a uv prerelease unless requires-python permits it', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.14.2', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.14,<3.16' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            getAvailablePythonVersionsStub.resolves([
                makeUvPythonVersion('3.15.0a6'),
                makeUvPythonVersion('3.14.2'),
            ]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.14,<3.16',
                version: '3.14.2',
            });
        });

        test('installs an explicitly permitted prerelease lower bound', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.15.0a1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.15.0a1,<3.16' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '>=3.15.0a1,<3.16',
                version: '3.15.0a1',
            });
        });

        test('normalizes a PEP 440 prerelease alias before installation', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.15.0rc1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.15.0c1' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([uvBase]);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri()));

            sinon.assert.calledOnceWithExactly(promptInstallPythonViaUvStub, 'inlineScript', manager.log, {
                requiresPython: '==3.15.0c1',
                version: '3.15.0rc1',
            });
        });

        test('does not prompt when requires-python has no safe lower bound', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '<3.13' });
            apiGetEnvironmentsStub.resolves([
                makeEnvironment('ms-python.python:system', '3.13.0', baseExecutable),
            ]);

            assert.strictEqual(await manager.create(scriptUri()), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        for (const [description, refreshedEnvironments] of [
            ['the installed interpreter is not compatible', [baseEnvironment]],
            ['no installed interpreter is reported', []],
        ] as const) {
            test(`does not build when ${description} after refresh`, async () => {
                readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
                apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
                apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
                apiGetEnvironmentsStub.onThirdCall().resolves(refreshedEnvironments);
                promptInstallPythonViaUvStub.resolves(baseExecutable);

                assert.strictEqual(await manager.create(scriptUri()), undefined);

                sinon.assert.calledOnceWithExactly(apiRefreshEnvironmentsStub, undefined);
                assert.strictEqual(lockStub.callCount, 0);
                assert.strictEqual(createWithProgressStub.callCount, 0);
            });
        }

        test('does not prompt when a compatible installed interpreter is available', async () => {
            assert.ok(await manager.create(scriptUri()));

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
        });

        test('does not prompt during quick create', async () => {
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);

            assert.strictEqual(await manager.create(scriptUri(), { quickCreate: true }), undefined);

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 0);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(lockStub.callCount, 0);
        });

        test('coalesces the full concurrent setup for the same script', async () => {
            const uri = scriptUri();
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            let installed = false;
            apiGetEnvironmentsStub.callsFake(async () => (installed ? [uvBase] : [baseEnvironment]));
            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                installed = true;
                return uvExecutable;
            });

            const first = manager.create(uri);
            await promptShown;
            const second = manager.create(uri);
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('coalesces concurrent setup requests for the same script when installation is declined', async () => {
            const uri = scriptUri();
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            let finishPrompt: ((value: undefined) => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(
                () =>
                    new Promise<undefined>((resolve) => {
                        signalPrompt!();
                        finishPrompt = resolve;
                    }),
            );

            const first = manager.create(uri);
            await promptShown;
            const second = manager.create(uri);
            finishPrompt!(undefined);
            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('coalesces simultaneous fallback requests for the same Python version', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });

            let isInstalled = false;
            let initialQueries = 0;
            let signalSecondInitialQuery: (() => void) | undefined;
            const secondInitialQuery = new Promise<void>((resolve) => {
                signalSecondInitialQuery = resolve;
            });
            apiGetEnvironmentsStub.callsFake(async () => {
                if (isInstalled) {
                    return [uvBase];
                }
                initialQueries += 1;
                if (initialQueries === 2) {
                    signalSecondInitialQuery!();
                }
                return [];
            });

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                isInstalled = true;
                return uvExecutable;
            });

            const first = manager.create(scriptUri('a.py'));
            await promptShown;
            const second = manager.create(scriptUri('b.py'));
            await secondInitialQuery;
            await Promise.resolve();
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a compatible installation for a queued request with a different lower bound', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.callsFake(async (uri: Uri) => ({
                ...VALID_METADATA,
                requiresPython: uri.fsPath.endsWith('compatible.py') ? '~=3.13.0' : '>=3.13',
            }));

            let installed = false;
            let queryCount = 0;
            let signalQueuedQuery: (() => void) | undefined;
            const queuedQuery = new Promise<void>((resolve) => {
                signalQueuedQuery = resolve;
            });
            apiGetEnvironmentsStub.callsFake(async () => {
                queryCount += 1;
                if (queryCount === 3) {
                    signalQueuedQuery!();
                }
                return installed ? [uvBase] : [];
            });

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                installed = true;
                return uvExecutable;
            });

            const first = manager.create(scriptUri('lower-bound.py'));
            await promptShown;
            const second = manager.create(scriptUri('compatible.py'));
            await queuedQuery;
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a directly resolved installation when discovery remains stale', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.resolves([baseEnvironment]);
            resolveSystemPythonStub.resolves(uvBase);

            let releaseInstall: (() => void) | undefined;
            let signalPrompt: (() => void) | undefined;
            const promptShown = new Promise<void>((resolve) => {
                signalPrompt = resolve;
            });
            const installGate = new Promise<void>((resolve) => {
                releaseInstall = resolve;
            });
            promptInstallPythonViaUvStub.callsFake(async () => {
                signalPrompt!();
                await installGate;
                return uvExecutable;
            });

            const first = manager.create(scriptUri('first.py'));
            await promptShown;
            const second = manager.create(scriptUri('second.py'));
            releaseInstall!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.ok(firstResult);
            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(apiRefreshEnvironmentsStub.callCount, 1);
            assert.strictEqual(resolveSystemPythonStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('reuses a directly resolved installation when later discovery throws', async () => {
            const uvExecutable = path.join(tempRoot, 'uv-python', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(uvExecutable, '');
            const uvBase = makeEnvironment('ms-python.python:system', '3.13.1', uvExecutable);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '>=3.13' });
            apiGetEnvironmentsStub.onFirstCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onSecondCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onThirdCall().resolves([baseEnvironment]);
            apiGetEnvironmentsStub.onCall(3).rejects(new Error('discovery unavailable'));
            resolveSystemPythonStub.resolves(uvBase);
            promptInstallPythonViaUvStub.resolves(uvExecutable);

            assert.ok(await manager.create(scriptUri('first.py')));
            assert.ok(await manager.create(scriptUri('second.py')));

            assert.strictEqual(promptInstallPythonViaUvStub.callCount, 1);
            assert.strictEqual(resolveSystemPythonStub.callCount, 1);
        });
    });

    suite('cache creation', () => {
        test('hashes and installs metadata plus additional packages, then writes the sidecar', async () => {
            const result = await manager.create(scriptUri(), { additionalPackages: ['pytest'] });

            assert.ok(result);
            assert.deepStrictEqual(computeCacheKeyStub.firstCall.args[0], {
                dependencies: ['requests', 'pytest'],
                interpreterPath: baseExecutable,
            });
            assert.strictEqual(createWithProgressStub.firstCall.args[0], nativeFinder);
            assert.strictEqual(createWithProgressStub.firstCall.args[1], api);
            assert.strictEqual(createWithProgressStub.firstCall.args[3], manager);
            assert.strictEqual(createWithProgressStub.firstCall.args[4], baseEnvironment);
            assert.strictEqual(createWithProgressStub.firstCall.args[5].fsPath, cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath);
            assert.strictEqual(createWithProgressStub.firstCall.args[6], envDir().fsPath);
            assert.deepStrictEqual(createWithProgressStub.firstCall.args[7], {
                install: ['requests', 'pytest'],
                uninstall: [],
            });
            assert.deepStrictEqual(writeMetaStub.firstCall.args, [
                envDir(),
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: baseExecutable,
                    baseInterpreterVersion: baseEnvironment.version,
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY),
                    ],
                },
            ]);
            assert.strictEqual(
                createWithProgressStub.firstCall.args[8],
                false,
                'inline-script cache entries must not be tracked as workspace uv environments',
            );
            assert.ok(releaseLockStub.calledOnce);
        });

        test('uses a bounded cross-process lock at the final cache path', async () => {
            await manager.create(scriptUri());

            assert.strictEqual(lockStub.firstCall.args[0], envDir().fsPath);
            const options = lockStub.firstCall.args[1];
            assert.ok(options.timeoutMs > 0);
            assert.ok(options.retryIntervalMs > 0);
        });

        test('coalesces simultaneous same-key creation within one extension host', async () => {
            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            let secondCallHashed: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const secondHashed = new Promise<void>((resolve) => {
                secondCallHashed = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            computeCacheKeyStub.callsFake(() => {
                if (computeCacheKeyStub.callCount === 2) {
                    secondCallHashed!();
                }
                return CACHE_KEY;
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                creationStarted!();
                await gate;
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            const first = manager.create(scriptUri('a.py'));
            await started;
            const second = manager.create(scriptUri('b.py'));
            await secondHashed;
            continueCreation!();
            const [firstResult, secondResult] = await Promise.all([first, second]);

            assert.strictEqual(firstResult, secondResult);
            assert.strictEqual(lockStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('records every successful same-key coalesced caller provenance for later set and restart routing', async () => {
            const cacheKeyValue = 'fedcba9876543210';
            const firstUri = scriptUri('a.py');
            const secondUri = scriptUri('b.py');
            const secondMetadata = {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            } satisfies metadataReader.InlineScriptMetadata;
            const firstIdentity = VALID_METADATA_IDENTITY;
            const secondIdentity = JSON.stringify({
                requiresPython: secondMetadata.requiresPython,
                dependencies: secondMetadata.dependencies,
            });
            const metadataByScript = new Map<string, metadataReader.InlineScriptMetadata>([
                [normalizePath(firstUri.fsPath), VALID_METADATA],
                [normalizePath(secondUri.fsPath), secondMetadata],
            ]);
            readMetadataStub.callsFake(async (uri: Uri) => metadataByScript.get(normalizePath(uri.fsPath)));
            routingRegistry.setMetadata(firstUri, VALID_METADATA);
            routingRegistry.setMetadata(secondUri, secondMetadata);
            registerCacheKey(cacheKeyValue, ['requests', 'pytest'], baseExecutable);

            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            let secondCallHashed: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const secondHashed = new Promise<void>((resolve) => {
                secondCallHashed = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            computeCacheKeyStub.callsFake((inputs: cacheKey.CacheKeyInputs) => {
                if (computeCacheKeyStub.callCount === 2) {
                    secondCallHashed!();
                }
                return cacheKeysByInputs.get(getCacheKeyInputKey(inputs.dependencies, inputs.interpreterPath)) ?? CACHE_KEY;
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                const environment = makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
                    venvPythonPath(target),
                    target,
                );
                environmentsByExecutablePath.set(normalizePath(environment.environmentPath.fsPath), environment);
                creationStarted!();
                await gate;
                return { environment };
            });

            const first = manager.create(firstUri, { additionalPackages: ['pytest'] });
            await started;
            const second = manager.create(secondUri, { additionalPackages: ['pytest'] });
            await secondHashed;
            continueCreation!();
            const [firstEnvironment, secondEnvironment] = await Promise.all([first, second]);

            assert.ok(firstEnvironment);
            assert.strictEqual(firstEnvironment, secondEnvironment);
            assert.strictEqual(lockStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 1);
            assert.deepStrictEqual(
                (
                    sidecarsByEnvDir.get(
                        normalizePath(cacheLayout.getScriptEnvDir(globalStorageUri, cacheKeyValue).fsPath),
                    ) as cacheLayout.InlineScriptEnvMeta
                ).sourceMetadataIdentityHashes,
                [
                    cacheLayout.hashSourceMetadataIdentity(firstIdentity),
                    cacheLayout.hashSourceMetadataIdentity(secondIdentity),
                ],
            );

            await manager.set(firstUri, firstEnvironment);
            await manager.set(secondUri, secondEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(firstUri.fsPath)]: matchedAssociationRecord(firstEnvironment.environmentPath.fsPath, firstIdentity),
                [normalizePath(secondUri.fsPath)]: matchedAssociationRecord(secondEnvironment!.environmentPath.fsPath, secondIdentity),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(firstUri), true);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(secondUri), true);

            persistedAssociations = {};
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            restartRoutingRegistry.setMetadata(firstUri, VALID_METADATA);
            restartRoutingRegistry.setMetadata(secondUri, secondMetadata);
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(firstUri, firstEnvironment);
            await restarted.set(secondUri, secondEnvironment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(firstUri.fsPath)]: matchedAssociationRecord(firstEnvironment.environmentPath.fsPath, firstIdentity),
                [normalizePath(secondUri.fsPath)]: matchedAssociationRecord(secondEnvironment!.environmentPath.fsPath, secondIdentity),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(firstUri), true);
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(secondUri), true);
            restarted.dispose();
        });

        test('merges a late same-key caller that arrives while the initial sidecar write is in flight', async () => {
            const cacheKeyValue = 'fedcba9876543210';
            const firstUri = scriptUri('a.py');
            const secondUri = scriptUri('b.py');
            const secondMetadata = {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            } satisfies metadataReader.InlineScriptMetadata;
            const secondIdentity = JSON.stringify({
                requiresPython: secondMetadata.requiresPython,
                dependencies: secondMetadata.dependencies,
            });
            const firstHash = cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY);
            const secondHash = cacheLayout.hashSourceMetadataIdentity(secondIdentity);
            const metadataByScript = new Map<string, metadataReader.InlineScriptMetadata>([
                [normalizePath(firstUri.fsPath), VALID_METADATA],
                [normalizePath(secondUri.fsPath), secondMetadata],
            ]);
            readMetadataStub.callsFake(async (uri: Uri) => metadataByScript.get(normalizePath(uri.fsPath)));
            registerCacheKey(cacheKeyValue, ['requests', 'pytest'], baseExecutable);
            let secondCallHashed: (() => void) | undefined;
            const secondHashed = new Promise<void>((resolve) => {
                secondCallHashed = resolve;
            });
            computeCacheKeyStub.callsFake((inputs: cacheKey.CacheKeyInputs) => {
                if (computeCacheKeyStub.callCount === 2) {
                    secondCallHashed!();
                }
                return cacheKeysByInputs.get(getCacheKeyInputKey(inputs.dependencies, inputs.interpreterPath)) ?? CACHE_KEY;
            });

            let releaseFirstWrite: (() => void) | undefined;
            let firstWriteStarted: (() => void) | undefined;
            const firstWriteGate = new Promise<void>((resolve) => {
                releaseFirstWrite = resolve;
            });
            const firstWritePending = new Promise<void>((resolve) => {
                firstWriteStarted = resolve;
            });
            let firstWrittenHashes: readonly string[] | undefined;
            writeMetaStub.callsFake(async (envDir: Uri, meta: cacheLayout.InlineScriptEnvMeta) => {
                if (writeMetaStub.callCount === 1) {
                    firstWrittenHashes = meta.sourceMetadataIdentityHashes;
                    firstWriteStarted!();
                    await firstWriteGate;
                }
                sidecarsByEnvDir.set(normalizePath(envDir.fsPath), meta);
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                const environment = makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
                    venvPythonPath(target),
                    target,
                );
                environmentsByExecutablePath.set(normalizePath(environment.environmentPath.fsPath), environment);
                return { environment };
            });

            const first = manager.create(firstUri, { additionalPackages: ['pytest'] });
            await firstWritePending;
            const second = manager.create(secondUri, { additionalPackages: ['pytest'] });
            await secondHashed;
            const pendingCreations = (
                manager as unknown as {
                    pendingCreations: Map<string, { sourceMetadataIdentityHashes?: readonly string[] }>;
                }
            ).pendingCreations;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (pendingCreations.get(cacheKeyValue)?.sourceMetadataIdentityHashes?.includes(secondHash)) {
                    break;
                }
                await nextTurn();
            }

            assert.deepStrictEqual(firstWrittenHashes, [firstHash]);
            assert.strictEqual(
                pendingCreations.get(cacheKeyValue)?.sourceMetadataIdentityHashes?.includes(secondHash),
                true,
            );

            releaseFirstWrite!();
            const [firstEnvironment, secondEnvironment] = await Promise.all([first, second]);

            assert.ok(firstEnvironment);
            assert.strictEqual(firstEnvironment, secondEnvironment);
            assert.strictEqual(createWithProgressStub.callCount, 1);
            assert.strictEqual(lockStub.callCount, 2);
            assert.deepStrictEqual(
                (
                    sidecarsByEnvDir.get(
                        normalizePath(cacheLayout.getScriptEnvDir(globalStorageUri, cacheKeyValue).fsPath),
                    ) as cacheLayout.InlineScriptEnvMeta
                ).sourceMetadataIdentityHashes,
                [firstHash, secondHash],
            );
        });

        for (const failureMode of ['lock', 'read', 'write'] as const) {
            test(`late same-key caller returns undefined when durable provenance merge ${failureMode} fails, but first caller and retry succeed`, async () => {
                const cacheKeyValue = 'fedcba9876543210';
                const firstUri = scriptUri('a.py');
                const secondUri = scriptUri('b.py');
                const secondMetadata = {
                    ...VALID_METADATA,
                    requiresPython: '>=3.12',
                } satisfies metadataReader.InlineScriptMetadata;
                const secondIdentity = JSON.stringify({
                    requiresPython: secondMetadata.requiresPython,
                    dependencies: secondMetadata.dependencies,
                });
                const firstHash = cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY);
                const secondHash = cacheLayout.hashSourceMetadataIdentity(secondIdentity);
                const metadataByScript = new Map<string, metadataReader.InlineScriptMetadata>([
                    [normalizePath(firstUri.fsPath), VALID_METADATA],
                    [normalizePath(secondUri.fsPath), secondMetadata],
                ]);
                readMetadataStub.callsFake(async (uri: Uri) => metadataByScript.get(normalizePath(uri.fsPath)));
                registerCacheKey(cacheKeyValue, ['requests', 'pytest'], baseExecutable);
                let secondCallHashed: (() => void) | undefined;
                const secondHashed = new Promise<void>((resolve) => {
                    secondCallHashed = resolve;
                });
                computeCacheKeyStub.callsFake((inputs: cacheKey.CacheKeyInputs) => {
                    if (computeCacheKeyStub.callCount === 2) {
                        secondCallHashed!();
                    }
                    return cacheKeysByInputs.get(getCacheKeyInputKey(inputs.dependencies, inputs.interpreterPath)) ?? CACHE_KEY;
                });

                let releaseFirstWrite: (() => void) | undefined;
                let firstWriteStarted: (() => void) | undefined;
                const firstWriteGate = new Promise<void>((resolve) => {
                    releaseFirstWrite = resolve;
                });
                const firstWritePending = new Promise<void>((resolve) => {
                    firstWriteStarted = resolve;
                });
                writeMetaStub.callsFake(async (envDir: Uri, meta: cacheLayout.InlineScriptEnvMeta) => {
                    if (writeMetaStub.callCount === 1) {
                        firstWriteStarted!();
                        await firstWriteGate;
                    }
                    sidecarsByEnvDir.set(normalizePath(envDir.fsPath), meta);
                });
                if (failureMode === 'lock') {
                    lockStub.onSecondCall().rejects(new Error('merge lock failed'));
                } else if (failureMode === 'read') {
                    inspectMetaStub.onFirstCall().rejects(new Error('merge read failed'));
                } else {
                    writeMetaStub.onSecondCall().rejects(new Error('merge write failed'));
                }
                createWithProgressStub.callsFake(async (...args: unknown[]) => {
                    const target = args[6] as string;
                    await fs.outputFile(venvPythonPath(target), '');
                    const environment = makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    );
                    environmentsByExecutablePath.set(normalizePath(environment.environmentPath.fsPath), environment);
                    return { environment };
                });

                const first = manager.create(firstUri, { additionalPackages: ['pytest'] });
                await firstWritePending;
                const second = manager.create(secondUri, { additionalPackages: ['pytest'] });
                await secondHashed;
                releaseFirstWrite!();
                const [firstEnvironment, secondEnvironment] = await Promise.all([first, second]);

                assert.ok(firstEnvironment);
                assert.strictEqual(secondEnvironment, undefined);
                assert.strictEqual(createWithProgressStub.callCount, 1);
                assert.deepStrictEqual(
                    (
                        sidecarsByEnvDir.get(
                            normalizePath(cacheLayout.getScriptEnvDir(globalStorageUri, cacheKeyValue).fsPath),
                        ) as cacheLayout.InlineScriptEnvMeta
                    ).sourceMetadataIdentityHashes,
                    [firstHash],
                );

                const retried = await manager.create(secondUri, { additionalPackages: ['pytest'] });

                assert.ok(retried);
                assert.strictEqual(normalizePath(retried!.environmentPath.fsPath), normalizePath(firstEnvironment.environmentPath.fsPath));
                assert.deepStrictEqual(
                    (
                        sidecarsByEnvDir.get(
                            normalizePath(cacheLayout.getScriptEnvDir(globalStorageUri, cacheKeyValue).fsPath),
                        ) as cacheLayout.InlineScriptEnvMeta
                    ).sourceMetadataIdentityHashes,
                    [firstHash, secondHash],
                );
                assert.strictEqual(createWithProgressStub.callCount, 1);
            });
        }

        test('does not record provenance when a shared same-key creation fails', async () => {
            const firstUri = scriptUri('a.py');
            const secondUri = scriptUri('b.py');
            const secondMetadata = {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            } satisfies metadataReader.InlineScriptMetadata;
            const metadataByScript = new Map<string, metadataReader.InlineScriptMetadata>([
                [normalizePath(firstUri.fsPath), VALID_METADATA],
                [normalizePath(secondUri.fsPath), secondMetadata],
            ]);
            readMetadataStub.callsFake(async (uri: Uri) => metadataByScript.get(normalizePath(uri.fsPath)));
            registerCacheKey(CACHE_KEY, ['requests', 'pytest'], baseExecutable);

            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            let secondCallHashed: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const secondHashed = new Promise<void>((resolve) => {
                secondCallHashed = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            computeCacheKeyStub.callsFake((inputs: cacheKey.CacheKeyInputs) => {
                if (computeCacheKeyStub.callCount === 2) {
                    secondCallHashed!();
                }
                return cacheKeysByInputs.get(getCacheKeyInputKey(inputs.dependencies, inputs.interpreterPath)) ?? CACHE_KEY;
            });
            createWithProgressStub.callsFake(async () => {
                creationStarted!();
                await gate;
                return { envCreationErr: 'boom' };
            });

            const first = manager.create(firstUri, { additionalPackages: ['pytest'] });
            await started;
            const second = manager.create(secondUri, { additionalPackages: ['pytest'] });
            await secondHashed;
            continueCreation!();

            assert.deepStrictEqual(await Promise.all([first, second]), [undefined, undefined]);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.strictEqual(sidecarsByEnvDir.size, 0);
        });

        test('dedupes and caps coalesced same-key provenance hashes before the first sidecar write', async () => {
            const cacheKeyValue = 'fedcba9876543210';
            const scriptSpecs = [
                ['script-0.py', '>=3.0'],
                ['script-1.py', '>=3.1'],
                ['script-2.py', '>=3.2'],
                ['script-3.py', '>=3.3'],
                ['script-4.py', '>=3.4'],
                ['script-5.py', '>=3.5'],
                ['script-6.py', '>=3.6'],
                ['script-7.py', '>=3.7'],
                ['script-8.py', '>=3.8'],
                ['script-9.py', '>=3.8'],
            ] as const;
            const metadataByScript = new Map<string, metadataReader.InlineScriptMetadata>(
                scriptSpecs.map(([name, requiresPython]) => [
                    normalizePath(scriptUri(name).fsPath),
                    {
                        ...VALID_METADATA,
                        requiresPython,
                    },
                ]),
            );
            let expectedHashes: readonly string[] | undefined;
            for (const [, requiresPython] of scriptSpecs) {
                expectedHashes = cacheLayout.mergeSourceMetadataIdentityHashes(
                    expectedHashes,
                    cacheLayout.hashSourceMetadataIdentity(
                        JSON.stringify({
                            requiresPython,
                            dependencies: ['requests'],
                        }),
                    ),
                );
            }
            readMetadataStub.callsFake(async (uri: Uri) => metadataByScript.get(normalizePath(uri.fsPath)));
            registerCacheKey(cacheKeyValue, ['requests', 'pytest'], baseExecutable);

            let continueCreation: (() => void) | undefined;
            let creationStarted: (() => void) | undefined;
            const started = new Promise<void>((resolve) => {
                creationStarted = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                continueCreation = resolve;
            });
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                const environment = makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
                    venvPythonPath(target),
                    target,
                );
                environmentsByExecutablePath.set(normalizePath(environment.environmentPath.fsPath), environment);
                creationStarted!();
                await gate;
                return { environment };
            });

            const pendingCreates = [manager.create(scriptUri(scriptSpecs[0][0]), { additionalPackages: ['pytest'] })];
            await started;
            const pendingCreations = (
                manager as unknown as {
                    pendingCreations: Map<string, { sourceMetadataIdentityHashes?: readonly string[] }>;
                }
            ).pendingCreations;
            const addPendingCreationSourceMetadataIdentityHashStub = sinon
                .stub(
                    manager as unknown as {
                        addPendingCreationSourceMetadataIdentityHash(
                            pendingCreation: { sourceMetadataIdentityHashes?: readonly string[] },
                            sourceMetadataIdentityHash: string | undefined,
                        ): void;
                    },
                    'addPendingCreationSourceMetadataIdentityHash',
                )
                .callThrough();
            for (const [name, requiresPython] of scriptSpecs.slice(1)) {
                const hash = cacheLayout.hashSourceMetadataIdentity(
                    JSON.stringify({
                        requiresPython,
                        dependencies: ['requests'],
                    }),
                );
                pendingCreates.push(manager.create(scriptUri(name), { additionalPackages: ['pytest'] }));
                await waitForStubCallCount(addPendingCreationSourceMetadataIdentityHashStub, pendingCreates.length - 1);
                assert.strictEqual(
                    pendingCreations.get(cacheKeyValue)?.sourceMetadataIdentityHashes?.includes(hash),
                    true,
                );
            }
            assert.deepStrictEqual(
                [...(pendingCreations.get(cacheKeyValue)?.sourceMetadataIdentityHashes ?? [])].sort(),
                [...(expectedHashes ?? [])].sort(),
            );
            continueCreation!();
            const environments = await Promise.all(pendingCreates);

            assert.ok(environments[0]);
            assert.ok(environments.every((environment) => environment === environments[0]));
            assert.strictEqual(lockStub.callCount, 1);
            const sourceMetadataIdentityHashes = (
                sidecarsByEnvDir.get(
                    normalizePath(cacheLayout.getScriptEnvDir(globalStorageUri, cacheKeyValue).fsPath),
                ) as cacheLayout.InlineScriptEnvMeta
            ).sourceMetadataIdentityHashes;
            assert.deepStrictEqual([...(sourceMetadataIdentityHashes ?? [])].sort(), [...(expectedHashes ?? [])].sort());
            assert.strictEqual(sourceMetadataIdentityHashes?.length, cacheLayout.MAX_SOURCE_METADATA_IDENTITY_HASHES);
            assert.strictEqual(sourceMetadataIdentityHashes ? new Set(sourceMetadataIdentityHashes).size : 0, sourceMetadataIdentityHashes?.length);
        });

        test('returns undefined without building when the cache lock cannot be acquired', async () => {
            lockStub.rejects(Object.assign(new Error('already locked'), { code: 'ELOCKED' }));
            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });
    });

    suite('cache reuse', () => {
        test('returns a valid cached environment and refreshes lastUsedAt', async () => {
            await fs.ensureDir(envDir().fsPath);
            const sidecar: cacheLayout.InlineScriptEnvMeta = {
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
            };
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            setSidecar(sidecar);
            resolveVenvStub.resolves(cached);

            const result = await manager.create(scriptUri());

            assert.strictEqual(result, cached);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.ok(baseInterpreterStatusStub.calledOnceWithExactly(envDir()));
            assert.strictEqual(resolveVenvStub.firstCall.args[0], venvPythonPath(envDir().fsPath));
            assert.deepStrictEqual(writeMetaStub.firstCall.args, [
                envDir(),
                {
                    ...sidecar,
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY),
                    ],
                },
            ]);
        });

        test('merges the current metadata identity hash into a reused cache sidecar', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
                sourceMetadataIdentityHashes: [cacheLayout.hashSourceMetadataIdentity('{"requiresPython":">=3.12","dependencies":["rich"]}')],
            });
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(cached);

            await manager.create(scriptUri());

            assert.deepStrictEqual(writeMetaStub.firstCall.args[1], {
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
                sourceMetadataIdentityHashes: [
                    cacheLayout.hashSourceMetadataIdentity('{"requiresPython":">=3.12","dependencies":["rich"]}'),
                    cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY),
                ],
            });
        });

        test('dedupes and caps reused cache provenance hashes', async () => {
            await fs.ensureDir(envDir().fsPath);
            const currentHash = cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY);
            const hashes = [
                currentHash,
                ...Array.from({ length: cacheLayout.MAX_SOURCE_METADATA_IDENTITY_HASHES - 1 }, (_, index) =>
                    cacheLayout.hashSourceMetadataIdentity(`identity-${index}`),
                ),
            ];
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
                sourceMetadataIdentityHashes: hashes,
            });
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(cached);

            await manager.create(scriptUri());

            assert.strictEqual((writeMetaStub.firstCall.args[1] as cacheLayout.InlineScriptEnvMeta).sourceMetadataIdentityHashes?.length, cacheLayout.MAX_SOURCE_METADATA_IDENTITY_HASHES);
        });

        test('preserves a cache entry with a future sidecar schema version', async () => {
            await fs.ensureDir(envDir().fsPath);
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            sidecarsByEnvDir.set(normalizePath(envDir().fsPath), 'unavailable');
            inspectMetaStub.callsFake(async () => ({ kind: 'unsupported' } as cacheLayout.InlineScriptMetaReadResult));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(markerPath), true);
        });

        test('returns a valid hit even when the last-used timestamp cannot be updated', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: '2026-07-01T00:00:00.000Z',
            });
            const cached = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                venvPythonPath(envDir().fsPath),
                envDir().fsPath,
            );
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(cached);
            writeMetaStub.rejects(new Error('read-only filesystem'));

            assert.strictEqual(await manager.create(scriptUri()), cached);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('preserves a valid cache entry when its environment cannot be resolved', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('removes and rebuilds a cache entry whose sidecar names another base', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: path.join(tempRoot, 'different-python'),
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });

            const result = await manager.create(scriptUri());

            assert.ok(result);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the base version changed at the same canonical path', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: '3.11.9',
                lastUsedAt: NOW.toISOString(),
            });

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('preserves the entry when resolution returns an environment owned by another manager', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:system',
                    '3.11.9',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('rebuilds an inline-owned entry whose resolved version is unparseable', async () => {
            await fs.outputFile(getVenvPythonPath(envDir().fsPath), '');
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    'Unknown',
                    getVenvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(await fs.pathExists(markerPath), false);
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the resolved environment no longer satisfies requires-python', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.10.0',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('rebuilds when the cached Python differs from the selected base but still satisfies the script', async () => {
            await fs.outputFile(venvPythonPath(envDir().fsPath), '');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            resolveVenvStub.resolves(
                makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.11.9',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
            );

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        for (const metadataKind of ['missing', 'invalid'] as const) {
            test(`rebuilds an existing cache entry when metadata is ${metadataKind}`, async () => {
                const markerPath = path.join(envDir().fsPath, 'keep.txt');
                await fs.outputFile(markerPath, 'keep');
                inspectMetaStub.resolves({ kind: metadataKind });

                assert.ok(await manager.create(scriptUri()));
                assert.strictEqual(await fs.pathExists(markerPath), false);
                assert.strictEqual(createWithProgressStub.callCount, 1);
                assert.strictEqual(writeMetaStub.callCount, 1);
            });
        }

        test('preserves an existing cache entry when metadata is unavailable', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            inspectMetaStub.resolves({ kind: 'unavailable' });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('preserves an existing cache entry when metadata inspection rejects', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            inspectMetaStub.rejects(new Error('transient read failure'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('preserves an existing cache entry when its base interpreter cannot be inspected', async () => {
            const markerPath = path.join(envDir().fsPath, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            baseInterpreterStatusStub.resolves('unavailable');

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('rebuilds an existing cache entry when its base interpreter is definitively missing', async () => {
            await fs.ensureDir(envDir().fsPath);
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            });
            baseInterpreterStatusStub.resolves('missing');

            assert.ok(await manager.create(scriptUri()));
            assert.strictEqual(createWithProgressStub.callCount, 1);
        });

        test('does not inspect or modify an entry resolving outside the physical cache root', async function () {
            const cacheRoot = cacheLayout.getScriptEnvCacheRoot(globalStorageUri);
            const externalEnv = path.join(tempRoot, 'external-env');
            const markerPath = path.join(externalEnv, 'keep.txt');
            await fs.ensureDir(cacheRoot.fsPath);
            await fs.outputFile(markerPath, 'keep');
            try {
                await fs.symlink(externalEnv, envDir().fsPath, isWindows() ? 'junction' : 'dir');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                    return;
                }
                throw error;
            }

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual((await fs.lstat(envDir().fsPath)).isSymbolicLink(), true);
            assert.strictEqual(inspectMetaStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });

        test('does not inspect or modify an entry aliasing another hash directory', async function () {
            const cacheRoot = cacheLayout.getScriptEnvCacheRoot(globalStorageUri);
            const otherEnv = path.join(cacheRoot.fsPath, 'fedcba9876543210');
            const markerPath = path.join(otherEnv, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            try {
                await fs.symlink(otherEnv, envDir().fsPath, isWindows() ? 'junction' : 'dir');
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'EACCES') {
                    this.skip();
                    return;
                }
                throw error;
            }

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.readFile(markerPath, 'utf8'), 'keep');
            assert.strictEqual((await fs.lstat(envDir().fsPath)).isSymbolicLink(), true);
            assert.strictEqual(inspectMetaStub.callCount, 0);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.strictEqual(createWithProgressStub.callCount, 0);
        });
    });

    suite('transaction rollback', () => {
        test('retains the partial environment and lock when package installation is cancelled', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                    pkgInstallationErr: 'Canceled',
                    pkgInstallationCancelled: true,
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), true);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.ok(retainLockStub.calledOnce);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('keeps a failed lock-retain transition fail-closed', async () => {
            createWithProgressStub.resolves({
                environment: makeEnvironment(
                    'ms-python.python:inline-script',
                    '3.12.4',
                    venvPythonPath(envDir().fsPath),
                    envDir().fsPath,
                ),
                pkgInstallationErr: 'Canceled',
                pkgInstallationCancelled: true,
            });
            retainLockStub.rejects(Object.assign(new Error('retention failed'), { code: 'EACCES' }));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.ok(retainLockStub.calledOnce);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes the partial environment when package installation fails', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.ensureDir(target);
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        venvPythonPath(target),
                        target,
                    ),
                    pkgInstallationErr: 'network failure',
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes the new environment when sidecar writing fails', async () => {
            writeMetaStub.rejects(new Error('disk full'));

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('removes a partial environment when createWithProgress throws', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                await fs.ensureDir(args[6] as string);
                throw new Error('unexpected create failure');
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.ok(releaseLockStub.calledOnce);
        });

        test('rejects and removes a created environment with a different Python release', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                await fs.outputFile(venvPythonPath(target), '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.11.9',
                        venvPythonPath(target),
                        target,
                    ),
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });

        test('rejects and removes a created environment outside the expected cache directory', async () => {
            createWithProgressStub.callsFake(async (...args: unknown[]) => {
                const target = args[6] as string;
                const otherRoot = path.join(tempRoot, 'unexpected-env');
                const otherPython = venvPythonPath(otherRoot);
                await fs.outputFile(venvPythonPath(target), '');
                await fs.outputFile(otherPython, '');
                return {
                    environment: makeEnvironment(
                        'ms-python.python:inline-script',
                        '3.12.4',
                        otherPython,
                        otherRoot,
                    ),
                };
            });

            assert.strictEqual(await manager.create(scriptUri()), undefined);
            assert.strictEqual(await fs.pathExists(envDir().fsPath), false);
            assert.strictEqual(writeMetaStub.callCount, 0);
        });
    });

    suite('events and disposal', () => {
        test('create does not establish an association or fire later-phase events', async () => {
            const environmentsListener = sinon.spy();
            const environmentListener = sinon.spy();
            manager.onDidChangeEnvironments(environmentsListener);
            manager.onDidChangeEnvironment(environmentListener);

            assert.ok(await manager.create(scriptUri()));
            assert.deepStrictEqual(await manager.getEnvironments('all'), []);
            assert.strictEqual(await manager.get(scriptUri()), undefined);
            assert.strictEqual(environmentsListener.callCount, 0);
            assert.strictEqual(environmentListener.callCount, 0);
        });

        test('dispose is idempotent', () => {
            manager.dispose();
            assert.doesNotThrow(() => manager.dispose());
        });
    });

    suite('script association persistence', () => {
        test('sets, gets, unsets, persists, and reports only actual selection changes', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, environment);

            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(workspaceState.set.firstCall.args[0], INLINE_SCRIPT_ENVS_KEY);
            assert.strictEqual(listener.callCount, 1);
            assert.deepStrictEqual(listener.firstCall.args[0], { uri, old: undefined, new: environment });

            await manager.set(uri, environment);
            assert.strictEqual(listener.callCount, 1);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(listener.callCount, 2);
            assert.deepStrictEqual(listener.secondCall.args[0], { uri, old: environment, new: undefined });
        });

        test('updates validated routing state when selections are set and unset', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            routingRegistry.setMetadata(uri, VALID_METADATA);

            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);

            await manager.set(uri, environment);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), true);

            await manager.set(uri, undefined);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('persists the saved metadata identity separately from the environment path', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();

            await manager.set(uri, environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
        });

        test('routes an environment created with additional packages by saved metadata identity', async () => {
            const uri = scriptUri();
            routingRegistry.setMetadata(uri, VALID_METADATA);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);

            assert.strictEqual(await manager.get(uri), environment);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), true);
        });

        test('reselecting the same matched additional-packages environment after restart preserves matched provenance', async () => {
            const uri = scriptUri();
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            await manager.set(uri, environment!);

            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(uri, environment!);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment!.environmentPath.fsPath),
            });
            restarted.dispose();
        });

        test('create with additional packages can route after reload before the first set via sidecar provenance', async () => {
            const uri = scriptUri();
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            persistedAssociations = {};

            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(uri, environment!);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment!.environmentPath.fsPath),
            });
            restarted.dispose();
        });

        test('does not reuse matched provenance after the same cache path is rebuilt for a different generation', async () => {
            const uri = scriptUri();
            const cacheKeyValue = 'fedcba9876543210';
            routingRegistry.setMetadata(uri, VALID_METADATA);
            const environment = await createOwnedEnvironment(cacheKeyValue);
            setSidecar(
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: path.join(
                        tempRoot,
                        `base-python-${cacheKeyValue}`,
                        isWindows() ? 'python.exe' : 'python',
                    ),
                    baseInterpreterVersion: baseEnvironment.version,
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity(VALID_METADATA_IDENTITY),
                    ],
                },
                Uri.file(path.dirname(path.dirname(environment.environmentPath.fsPath))),
            );

            await manager.set(uri, environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment!.environmentPath.fsPath),
            });

            const rebuiltMetadata = {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            } satisfies metadataReader.InlineScriptMetadata;
            const rebuiltBaseExecutable = path.join(tempRoot, 'rebuilt-base', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(rebuiltBaseExecutable, '');
            setSidecar(
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: rebuiltBaseExecutable,
                    baseInterpreterVersion: '3.12.9',
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity(
                            JSON.stringify({
                                requiresPython: rebuiltMetadata.requiresPython,
                                dependencies: rebuiltMetadata.dependencies,
                            }),
                        ),
                    ],
                },
                Uri.file(path.dirname(path.dirname(environment!.environmentPath.fsPath))),
            );

            await manager.set(uri, environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: {
                    schemaVersion: 1,
                    environmentPath: environment!.environmentPath.fsPath,
                    metadataBinding: { kind: 'legacy' },
                },
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('does not infer matched provenance when the sidecar source identity hash does not match', async () => {
            const sourceUri = scriptUri('source.py');
            const targetUri = scriptUri('target.py');
            const sourceMetadata = {
                ...VALID_METADATA,
                dependencies: ['rich'],
            } satisfies metadataReader.InlineScriptMetadata;
            routingRegistry.setMetadata(targetUri, VALID_METADATA);
            registerCacheKey('fedcba9876543210', ['rich', 'pytest'], baseExecutable);
            readMetadataStub.resolves(sourceMetadata);
            const environment = await manager.create(sourceUri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            readMetadataStub.resolves(VALID_METADATA);

            await manager.set(targetUri, environment!);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(targetUri.fsPath)]: {
                    schemaVersion: 1,
                    environmentPath: environment!.environmentPath.fsPath,
                    metadataBinding: { kind: 'legacy' },
                },
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(targetUri), false);
        });

        test('reselecting a different owned env after restart does not inherit matched provenance', async () => {
            const uri = scriptUri();
            const otherUri = scriptUri('other.py');
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const matchedEnvironment = await manager.create(uri, { additionalPackages: ['pytest'] });
            const otherMetadata = {
                ...VALID_METADATA,
                dependencies: ['urllib3'],
            } satisfies metadataReader.InlineScriptMetadata;
            registerCacheKey('0011223344556677', ['urllib3', 'pytest', 'rich'], baseExecutable);
            readMetadataStub.resolves(otherMetadata);
            const differentOwnedEnvironment = await manager.create(otherUri, { additionalPackages: ['pytest', 'rich'] });
            readMetadataStub.resolves(VALID_METADATA);
            assert.ok(matchedEnvironment);
            assert.ok(differentOwnedEnvironment);
            await manager.set(uri, matchedEnvironment!);

            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(uri, differentOwnedEnvironment!);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: {
                    schemaVersion: 1,
                    environmentPath: differentOwnedEnvironment!.environmentPath.fsPath,
                    metadataBinding: { kind: 'legacy' },
                },
            });
            restarted.dispose();
        });

        test('old sidecars without provenance keep additional-packages envs conservative on reload', async () => {
            const uri = scriptUri();
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            const envDirPath = path.dirname(path.dirname(environment!.environmentPath.fsPath));
            setSidecar({
                schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                baseInterpreterPath: baseExecutable,
                baseInterpreterVersion: baseEnvironment.version,
                lastUsedAt: NOW.toISOString(),
            }, Uri.file(envDirPath));
            persistedAssociations = {};

            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(uri, environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: {
                    schemaVersion: 1,
                    environmentPath: environment!.environmentPath.fsPath,
                    metadataBinding: { kind: 'legacy' },
                },
            });
            restarted.dispose();
        });

        test('stores a pending verified binding for a dirty selection and promotes it on matching save', async () => {
            const uri = scriptUri();
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment!.environmentPath.fsPath),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);

            openDocumentsStub.returns([]);
            await triggerSavedMetadataChange(routingRegistry, manager, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment!.environmentPath.fsPath),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), true);
        });

        test('dirty pending binding for the same path after restart keeps pending until saved metadata is consistent', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            };
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            await restarted.set(uri, environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('keeps a dirty pending binding non-routeable when the saved metadata identity no longer matches', async () => {
            const uri = scriptUri();
            const changedMetadata = {
                ...VALID_METADATA,
                dependencies: ['urllib3'],
            } satisfies metadataReader.InlineScriptMetadata;
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment!.environmentPath.fsPath),
            });

            openDocumentsStub.returns([]);
            routingRegistry.setMetadata(uri, changedMetadata);
            await triggerSavedMetadataChange(routingRegistry, manager, uri, changedMetadata);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment!.environmentPath.fsPath),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('failed pending bind invalidates warm validation before a retry within 5s', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            resolveVenvStub.resolves(environment);

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            workspaceState.set.onFirstCall().rejects(new Error('Memento unavailable'));
            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000 - 1);

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('removes a dirty pending binding when the environment was deleted before save validation', async () => {
            const uri = scriptUri();
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);
            await fs.remove(environment!.environmentPath.fsPath);

            openDocumentsStub.returns([]);
            routingRegistry.setMetadata(uri, VALID_METADATA);
            await triggerSavedMetadataChange(routingRegistry, manager, uri);

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('keeps a dirty pending binding non-routeable when validation is transiently unavailable on save', async () => {
            const uri = scriptUri();
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);
            resolveVenvStub.resolves(undefined);
            openDocumentsStub.returns([]);
            routingRegistry.setMetadata(uri, VALID_METADATA);
            await triggerSavedMetadataChange(routingRegistry, manager, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment!.environmentPath.fsPath),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('keeps a dirty pending binding non-routeable when ownership validation changes on save', async () => {
            const uri = scriptUri();
            const openDocumentsStub = workspaceApis.getOpenTextDocuments as unknown as sinon.SinonStub;
            openDocumentsStub.returns([{ uri, isDirty: true } as unknown as TextDocument]);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);

            await manager.set(uri, environment!);
            resolveVenvStub.resolves({
                ...environment!,
                envId: { ...environment!.envId, managerId: 'ms-python.python:system' },
            });
            openDocumentsStub.returns([]);
            routingRegistry.setMetadata(uri, VALID_METADATA);
            await triggerSavedMetadataChange(routingRegistry, manager, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment!.environmentPath.fsPath),
            });
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('removes only the requested malformed entry while preserving valid and legacy records', async () => {
            const invalidUri = scriptUri('invalid.py');
            const validUri = scriptUri('valid.py');
            const legacyUri = scriptUri('legacy.py');
            const validEnvironment = await createOwnedEnvironment('fedcba9876543210');
            const legacyEnvironment = await createOwnedEnvironment('0011223344556677');
            persistedAssociations = {
                [normalizePath(invalidUri.fsPath)]: { schemaVersion: 1, environmentPath: '', metadataBinding: { kind: 'pending' } },
                [normalizePath(validUri.fsPath)]: matchedAssociationRecord(validEnvironment.environmentPath.fsPath),
                [normalizePath(legacyUri.fsPath)]: legacyEnvironment.environmentPath.fsPath,
            };
            resolveVenvStub.callsFake(async (environmentPath: string) => {
                const normalized = normalizePath(environmentPath);
                if (normalized === normalizePath(validEnvironment.environmentPath.fsPath)) {
                    return validEnvironment;
                }
                if (normalized === normalizePath(legacyEnvironment.environmentPath.fsPath)) {
                    return legacyEnvironment;
                }
                return undefined;
            });

            assert.strictEqual(await manager.get(invalidUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(validUri.fsPath)]: matchedAssociationRecord(validEnvironment.environmentPath.fsPath),
                [normalizePath(legacyUri.fsPath)]: legacyEnvironment.environmentPath.fsPath,
            });
            assert.strictEqual(await manager.get(validUri), validEnvironment);
            assert.strictEqual(await manager.get(legacyUri), legacyEnvironment);
        });

        test('preserves unknown future-version entries when repairing a malformed requested entry', async () => {
            const invalidUri = scriptUri('invalid.py');
            const futureUri = scriptUri('future.py');
            const futureEnvironment = await createOwnedEnvironment('8899aabbccddeeff');
            persistedAssociations = {
                [normalizePath(invalidUri.fsPath)]: { schemaVersion: 1, environmentPath: '', metadataBinding: { kind: 'pending' } },
                [normalizePath(futureUri.fsPath)]: futureAssociationRecord(futureEnvironment.environmentPath.fsPath),
            };

            assert.strictEqual(await manager.get(invalidUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(futureUri.fsPath)]: futureAssociationRecord(futureEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(futureUri), undefined);
        });

        test('removes a requested record with an unknown current binding kind without affecting unrelated entries', async () => {
            const invalidUri = scriptUri('invalid.py');
            const validUri = scriptUri('valid.py');
            const validEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(invalidUri.fsPath)]: {
                    schemaVersion: 1,
                    environmentPath: validEnvironment.environmentPath.fsPath,
                    metadataBinding: { kind: 'mystery' },
                },
                [normalizePath(validUri.fsPath)]: matchedAssociationRecord(validEnvironment.environmentPath.fsPath),
            };
            resolveVenvStub.resolves(validEnvironment);

            assert.strictEqual(await manager.get(invalidUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(validUri.fsPath)]: matchedAssociationRecord(validEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(validUri), validEnvironment);
        });

        test('persists a batch atomically and reports each distinct script URI exactly once', async () => {
            const first = scriptUri('first.py');
            const second = scriptUri('second.py');
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set([first, second, first], environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(first.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
                [normalizePath(second.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(workspaceStateSetCalls(INLINE_SCRIPT_ENVS_KEY).length, 1);
            assert.strictEqual(listener.callCount, 2);
            assert.strictEqual(listener.firstCall.args[0].uri, first);
            assert.strictEqual(listener.secondCall.args[0].uri, second);
            assert.strictEqual(await manager.get(first), environment);
            assert.strictEqual(await manager.get(second), environment);
        });

        test('serializes concurrent selections so neither persisted association is lost', async () => {
            const firstUri = scriptUri('first.py');
            const secondUri = scriptUri('second.py');
            const firstEnvironment = await createOwnedEnvironment();
            const secondEnvironment = await createOwnedEnvironment('fedcba9876543210');

            await Promise.all([
                manager.set(firstUri, firstEnvironment),
                manager.set(secondUri, secondEnvironment),
            ]);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(firstUri.fsPath)]: matchedAssociationRecord(firstEnvironment.environmentPath.fsPath),
                [normalizePath(secondUri.fsPath)]: matchedAssociationRecord(secondEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(firstUri), firstEnvironment);
            assert.strictEqual(await manager.get(secondUri), secondEnvironment);
        });

        test('does not let pending binding overwrite a newer unset', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            const pendingBind = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);
            await restarted.set(uri, undefined);
            resolvePending!(environment);
            await pendingBind;

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('does not let pending binding overwrite a newer matched selection', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const newEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(oldEnvironment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            const pendingBind = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);
            await restarted.set(uri, newEnvironment);
            resolvePending!(oldEnvironment);
            await pendingBind;

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(newEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(await restarted.get(uri), newEnvironment);
            restarted.dispose();
        });

        test('preserves a concurrent valid set while repairing an unrelated malformed entry', async () => {
            const invalidUri = scriptUri('invalid.py');
            const validUri = scriptUri('valid.py');
            const validEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(invalidUri.fsPath)]: { schemaVersion: 1, environmentPath: '', metadataBinding: { kind: 'pending' } },
            };

            await Promise.all([manager.get(invalidUri), manager.set(validUri, validEnvironment)]);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(validUri.fsPath)]: matchedAssociationRecord(validEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(validUri), validEnvironment);
        });

        test('leaves a pending binding non-routeable when persistence fails', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            resolveVenvStub.resolves(environment);

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            ((restarted as unknown as { subscriptions: Disposable[] }).subscriptions[0]).dispose();
            workspaceState.set.onFirstCall().rejects(new Error('Memento unavailable'));
            workspaceState.set.onSecondCall().rejects(new Error('Memento unavailable'));
            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('does not publish routeability from raw persisted associations after startup', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('legacy string associations stay non-routeable after restart but remain retrievable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            assert.strictEqual(await restarted.get(uri), environment);
            restarted.dispose();
        });

        test('routes a persisted matched additional-packages association on restart when the current sidecar hash matches', async () => {
            const uri = scriptUri();
            routingRegistry.setMetadata(uri, VALID_METADATA);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);
            restarted.dispose();
        });

        test('does not route a persisted matched association on restart when the same cache path was rebuilt for another identity', async () => {
            const uri = scriptUri();
            const cacheKeyValue = 'fedcba9876543210';
            const environment = await createOwnedEnvironment(cacheKeyValue);
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            };
            const rebuiltMetadata = {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            } satisfies metadataReader.InlineScriptMetadata;
            const rebuiltBaseExecutable = path.join(tempRoot, 'rebuilt-base-restart', isWindows() ? 'python.exe' : 'python');
            await fs.outputFile(rebuiltBaseExecutable, '');
            setSidecar(
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: rebuiltBaseExecutable,
                    baseInterpreterVersion: '3.12.9',
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity(
                            JSON.stringify({
                                requiresPython: rebuiltMetadata.requiresPython,
                                dependencies: rebuiltMetadata.dependencies,
                            }),
                        ),
                    ],
                },
                Uri.file(path.dirname(path.dirname(environment.environmentPath.fsPath))),
            );
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            assert.strictEqual(await restarted.get(uri), environment);
            restarted.dispose();
        });

        test('does not promote a pending association when the current sidecar hash does not prove its source identity', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            };
            setSidecar(
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: path.join(
                        tempRoot,
                        'base-python-fedcba9876543210',
                        isWindows() ? 'python.exe' : 'python',
                    ),
                    baseInterpreterVersion: baseEnvironment.version,
                    lastUsedAt: NOW.toISOString(),
                    sourceMetadataIdentityHashes: [
                        cacheLayout.hashSourceMetadataIdentity('{"requiresPython":">=3.12","dependencies":["requests"]}'),
                    ],
                },
                Uri.file(path.dirname(path.dirname(environment.environmentPath.fsPath))),
            );
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: pendingAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('preserves a persisted matched association with a future sidecar but leaves it non-routeable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const markerPath = path.join(environment.sysPrefix, 'keep.txt');
            await fs.outputFile(markerPath, 'keep');
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            };
            inspectMetaStub.callsFake(async (envDir: Uri) =>
                normalizePath(envDir.fsPath) === normalizePath(environment.sysPrefix)
                    ? ({ kind: 'unsupported' } as cacheLayout.InlineScriptMetaReadResult)
                    : ({ kind: 'missing' } as cacheLayout.InlineScriptMetaReadResult),
            );
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            assert.strictEqual(await restarted.get(uri), environment);
            assert.strictEqual(await fs.pathExists(markerPath), true);
            restarted.dispose();
        });

        test('keeps a persisted matched additional-packages association non-routeable on restart when only an old sidecar remains', async () => {
            const uri = scriptUri();
            routingRegistry.setMetadata(uri, VALID_METADATA);
            registerCacheKey('fedcba9876543210', ['requests', 'pytest'], baseExecutable);
            const environment = await manager.create(uri, { additionalPackages: ['pytest'] });
            assert.ok(environment);
            setSidecar(
                {
                    schemaVersion: cacheLayout.META_SCHEMA_VERSION,
                    baseInterpreterPath: baseExecutable,
                    baseInterpreterVersion: baseEnvironment.version,
                    lastUsedAt: NOW.toISOString(),
                },
                Uri.file(path.dirname(path.dirname(environment.environmentPath.fsPath))),
            );
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('enables routeability only after persisted validation succeeds on restart', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            resolveVenvStub.resolves(environment);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            const pending = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);
            await pending;

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);
            restarted.dispose();
        });

        test('keeps routeability disabled while persisted restart validation is still in flight', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            let resolveRehydration: ((value: PythonEnvironment) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment>((resolve) => {
                        resolveRehydration = resolve;
                    }),
            );
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            const pending = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            resolveRehydration!(environment);
            await pending;

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);
            restarted.dispose();
        });

        test('ignores a stale saved-metadata refresh when metadata changes while sidecar proof awaits', async () => {
            const uri = scriptUri();
            const scriptPath = normalizePath(uri.fsPath);
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const refreshManager = asMetadataRefreshManager(manager);
            refreshManager.subscriptions[0].dispose();
            const validatedAtBefore = refreshManager.cachedAssociationValidatedAt.get(scriptPath);
            assert.ok(validatedAtBefore !== undefined);
            const routeabilityListener = sinon.spy();
            routingRegistry.onDidChangeRouteability(routeabilityListener);
            clock.tick(1);
            routingRegistry.setMetadata(uri, VALID_METADATA);
            const metadataIdentity = routingRegistry.getMetadataIdentity(uri)!;
            const metadataRevision = routingRegistry.getMetadataRevision(uri);
            let resolveProof: ((value: boolean) => void) | undefined;
            const proofStub = sinon.stub(refreshManager, 'currentCacheEntryProvesSourceMetadataIdentity').callThrough();
            proofStub.onFirstCall().returns(
                new Promise<boolean>((resolve) => {
                    resolveProof = resolve;
                }),
            );

            const pendingRefresh = refreshManager.refreshValidatedAssociationForMetadataInternal(
                scriptPath,
                uri,
                VALID_METADATA,
                metadataIdentity,
                metadataRevision,
                refreshManager.associationRevisions.get(scriptPath) ?? 0,
            );
            await waitForStubCall(proofStub);
            routingRegistry.setMetadata(uri, {
                ...VALID_METADATA,
                requiresPython: '>=3.12',
            });
            resolveProof!(true);
            await pendingRefresh;

            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
            assert.strictEqual(routeabilityListener.callCount, 0);
            assert.strictEqual(refreshManager.cachedAssociationValidatedAt.get(scriptPath), validatedAtBefore);
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentities.get(scriptPath), VALID_METADATA_IDENTITY);
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentityProofs.has(scriptPath), false);
        });

        test('ignores a stale saved-metadata refresh when an unset wins while sidecar proof awaits', async () => {
            const uri = scriptUri();
            const scriptPath = normalizePath(uri.fsPath);
            const environment = await createOwnedEnvironment();
            const refreshManager = asMetadataRefreshManager(manager);
            refreshManager.subscriptions[0].dispose();
            routingRegistry.setMetadata(uri, VALID_METADATA);
            await manager.set(uri, environment);
            const routeabilityListener = sinon.spy();
            routingRegistry.onDidChangeRouteability(routeabilityListener);
            clock.tick(1);
            let resolveProof: ((value: boolean) => void) | undefined;
            const proofStub = sinon.stub(refreshManager, 'currentCacheEntryProvesSourceMetadataIdentity').callThrough();
            proofStub.onFirstCall().returns(
                new Promise<boolean>((resolve) => {
                    resolveProof = resolve;
                }),
            );

            const pendingRefresh = refreshManager.refreshValidatedAssociationForMetadataInternal(
                scriptPath,
                uri,
                VALID_METADATA,
                routingRegistry.getMetadataIdentity(uri)!,
                routingRegistry.getMetadataRevision(uri),
                refreshManager.associationRevisions.get(scriptPath) ?? 0,
            );
            await waitForStubCall(proofStub);
            await manager.set(uri, undefined);
            resolveProof!(true);
            await pendingRefresh;

            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
            sinon.assert.calledOnceWithExactly(routeabilityListener, {
                uri,
                previousRouteable: true,
                routeable: false,
            });
            assert.strictEqual(refreshManager.cachedAssociationValidatedAt.has(scriptPath), false);
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentities.has(scriptPath), false);
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentityProofs.has(scriptPath), false);
            assert.deepStrictEqual(persistedAssociations, {});
        });

        test('ignores a stale saved-metadata refresh when a replacement wins while sidecar proof awaits', async () => {
            const uri = scriptUri();
            const scriptPath = normalizePath(uri.fsPath);
            const oldEnvironment = await createOwnedEnvironment();
            const replacementEnvironment = await createOwnedEnvironment('fedcba9876543210');
            const refreshManager = asMetadataRefreshManager(manager);
            refreshManager.subscriptions[0].dispose();
            routingRegistry.setMetadata(uri, VALID_METADATA);
            await manager.set(uri, oldEnvironment);
            const routeabilityListener = sinon.spy();
            routingRegistry.onDidChangeRouteability(routeabilityListener);
            clock.tick(1);
            let resolveProof: ((value: boolean) => void) | undefined;
            const proofStub = sinon.stub(refreshManager, 'currentCacheEntryProvesSourceMetadataIdentity').callThrough();
            proofStub.onFirstCall().returns(
                new Promise<boolean>((resolve) => {
                    resolveProof = resolve;
                }),
            );

            const pendingRefresh = refreshManager.refreshValidatedAssociationForMetadataInternal(
                scriptPath,
                uri,
                VALID_METADATA,
                routingRegistry.getMetadataIdentity(uri)!,
                routingRegistry.getMetadataRevision(uri),
                refreshManager.associationRevisions.get(scriptPath) ?? 0,
            );
            await waitForStubCall(proofStub);
            await manager.set(uri, replacementEnvironment);
            const validatedAtAfterReplacement = refreshManager.cachedAssociationValidatedAt.get(scriptPath);
            resolveProof!(false);
            await pendingRefresh;

            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), true);
            assert.strictEqual(routeabilityListener.callCount, 0);
            assert.strictEqual(
                refreshManager.cachedAssociationValidatedAt.get(scriptPath),
                validatedAtAfterReplacement,
            );
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentities.get(scriptPath), VALID_METADATA_IDENTITY);
            assert.strictEqual(refreshManager.lastValidatedMetadataIdentityProofs.has(scriptPath), false);
            assert.deepStrictEqual(persistedAssociations, {
                [scriptPath]: matchedAssociationRecord(replacementEnvironment.environmentPath.fsPath),
            });
        });

        test('preserves a persisted restart candidate after transient validation failure and retries later', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            resolveVenvStub.onFirstCall().rejects(new Error('resolver unavailable'));
            resolveVenvStub.onSecondCall().resolves(environment);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);
            restarted.dispose();
        });

        test('clears a stale persisted restart candidate instead of routing it', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            await fs.remove(environment.environmentPath.fsPath);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();

            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);
            restarted.dispose();
        });

        test('rehydrates a persisted owned association on demand after restart', async () => {
            const uri = scriptUri();
            const persistedEnvironment = await createOwnedEnvironment();
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(persistedEnvironment.environmentPath.fsPath),
            };
            const rehydrated = { ...persistedEnvironment, envId: { ...persistedEnvironment.envId, id: 'rehydrated' } };
            resolveVenvStub.resolves(rehydrated);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );

            assert.strictEqual(await restarted.get(uri), rehydrated);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(persistedEnvironment.environmentPath.fsPath),
            });

            const listener = sinon.spy();
            restarted.onDidChangeEnvironment(listener);
            await restarted.set(uri, persistedEnvironment);
            assert.strictEqual(listener.callCount, 0, 'different generated IDs for the same executable are not a change');

            restarted.dispose();
        });

        test('preserves and retries a cold association when resolution rejects', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            resolveVenvStub.onFirstCall().rejects(new Error('resolver unavailable'));
            resolveVenvStub.onSecondCall().resolves(environment);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('preserves and retries a cold association when ownership inspection rejects', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            resolveVenvStub.resolves(environment);
            const inspectionManager = manager as unknown as {
                inspectAssociationOwnership(
                    candidate: PythonEnvironment,
                ): Promise<'expected' | 'stale' | 'uncertain'>;
            };
            const ownershipStub = sinon.stub(inspectionManager, 'inspectAssociationOwnership').callThrough();
            ownershipStub.onFirstCall().rejects(new Error('filesystem unavailable'));

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('notifies when a slow persisted association finishes rehydrating', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            let resolveRehydration: ((value: PythonEnvironment) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment>((resolve) => {
                        resolveRehydration = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            const pending = manager.get(uri);
            await waitForStubCall(resolveVenvStub);
            assert.strictEqual(listener.callCount, 0);
            resolveRehydration!(environment);

            assert.strictEqual(await pending, environment);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: undefined, new: environment });
        });

        test('coalesces repeated saved-metadata validation for the same identity', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            let resolveRehydration: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveRehydration = resolve;
                    }),
            );
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            const listener = sinon.spy();
            restarted.onDidChangeEnvironment(listener);
            await nextTurn();

            const first = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            await waitForStubCall(resolveVenvStub);
            const second = triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            assert.strictEqual(resolveVenvStub.callCount, 1);

            resolveRehydration!(environment);
            await Promise.all([first, second]);

            assert.strictEqual(listener.callCount, 1);
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);
            restarted.dispose();
        });

        test('does not rewrite or notify when a restart reselects the same persisted executable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();
            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            const listener = sinon.spy();
            restarted.onDidChangeEnvironment(listener);

            await restarted.set(uri, environment);

            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(listener.callCount, 0);
            assert.strictEqual(resolveVenvStub.callCount, 0);

            restarted.dispose();
        });

        test('does not return a retained association when current metadata no longer accepts its Python version', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '==3.11.*' });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });

            readMetadataStub.resolves(VALID_METADATA);
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('does not return a retained association when current metadata dependencies changed', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            computeCacheKeyStub
                .withArgs(
                    sinon.match((inputs: cacheKey.CacheKeyInputs) => inputs.dependencies.length === 1 && inputs.dependencies[0] === 'urllib3'),
                )
                .returns('different-cache-key');
            readMetadataStub.resolves({ ...VALID_METADATA, dependencies: ['urllib3'] });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });

            readMetadataStub.resolves(VALID_METADATA);
            assert.strictEqual(await manager.get(uri), environment);
        });

        test('does not return a retained association when current requires-python identity changed, even if compatible', async () => {
            const uri = scriptUri();
            const environment = {
                ...(await createOwnedEnvironment()),
                version: '3.15.0',
            };
            await manager.set(uri, environment);
            resolveVenvStub.resolves(environment);
            readMetadataStub.resolves({ ...VALID_METADATA, requiresPython: '!=3.15.0rc2' });

            assert.strictEqual(await manager.get(uri), undefined);
        });

        test('does not resolve or discard an association when metadata is absent or unreadable', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            readMetadataStub.resolves(undefined);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
        });

        test('preserves a cold persisted association while its cache entry is locked', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            const lockPath = `${path.resolve(environment.sysPrefix)}.lock`;
            await fs.ensureDir(lockPath);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(resolveVenvStub.callCount, 0);
        });

        test('clears the routing registry when a stale persisted association is removed', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath) };
            resolveVenvStub.resolves(environment);
            const restartRoutingRegistry = new InlineScriptRoutingRegistry();

            const restarted = new InlineScriptEnvManager(
                nativeFinder,
                api,
                baseManager,
                globalStorageUri,
                makeFakeLog(),
                restartRoutingRegistry,
            );
            await nextTurn();
            await triggerSavedMetadataChange(restartRoutingRegistry, restarted, uri);
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), true);

            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000);
            assert.strictEqual(await restarted.get(uri), undefined);
            assert.strictEqual(restartRoutingRegistry.hasValidatedAssociation(uri), false);

            restarted.dispose();
        });

        test('clears persisted association state when the script path is deleted', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);

            fireDelete(uri);
            await nextTurn();
            await nextTurn();

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(uri), false);
        });

        test('clears persisted association state for the old path when a script is renamed', async () => {
            const oldUri = scriptUri('old.py');
            const newUri = scriptUri('new.py');
            const environment = await createOwnedEnvironment();
            await manager.set(oldUri, environment);

            fireRename(oldUri, newUri);
            await nextTurn();
            await nextTurn();

            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(await manager.get(oldUri), undefined);
            assert.strictEqual(routingRegistry.hasValidatedAssociation(oldUri), false);
        });

        test('removes and notifies for a warm association whose executable was deleted', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: undefined });
        });

        test('clears a case-variant persisted path when its warm executable is deleted', async function () {
            if (!isWindows()) {
                this.skip();
            }
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath.toUpperCase(),
            };
            resolveVenvStub.resolves(environment);
            assert.strictEqual(await manager.get(uri), environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            resolveVenvStub.resetHistory();
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: undefined });
        });

        test('preserves a warm association while its cache entry is locked', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            await fs.remove(environment.environmentPath.fsPath);
            await fs.ensureDir(`${path.resolve(environment.sysPrefix)}.lock`);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(listener.callCount, 0);
        });

        test('refreshes a warm association rebuilt at the same cache path', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const rebuilt = {
                ...environment,
                envId: { ...environment.envId, id: 'rebuilt' },
                version: '3.13.1',
            };
            resolveVenvStub.resolves(rebuilt);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), rebuilt);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: rebuilt });
        });

        test('retains warm environment identity when validation finds the same version', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            resolveVenvStub.resolves({
                ...environment,
                envId: { ...environment.envId, id: 'new-generated-id' },
            });
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), environment);
            assert.strictEqual(listener.callCount, 0);
        });

        test('refreshes warm validation timestamps when validation keeps the same environment', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            resolveVenvStub.resolves({
                ...environment,
                envId: { ...environment.envId, id: 'new-generated-id' },
            });
            clock.tick(5_000);

            assert.strictEqual(await manager.get(uri), environment);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            assert.strictEqual(await manager.get(uri), environment);
            assert.strictEqual(resolveVenvStub.callCount, 1);
        });

        test('lets an unset win while warm validation awaits sidecar proof', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const validationManager = manager as unknown as {
                currentCacheEntryProvesSourceMetadataIdentity(
                    candidate: PythonEnvironment,
                    metadataIdentity: string,
                    metadata: metadataReader.InlineScriptMetadata,
                ): Promise<boolean>;
            };
            let resolveProof: ((value: boolean) => void) | undefined;
            const proofStub = sinon.stub(validationManager, 'currentCacheEntryProvesSourceMetadataIdentity').callThrough();
            proofStub.onFirstCall().returns(
                new Promise<boolean>((resolve) => {
                    resolveProof = resolve;
                }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const pendingGet = manager.get(uri);
            await waitForStubCall(proofStub);
            await manager.set(uri, undefined);
            resolveProof!(true);

            assert.strictEqual(await pendingGet, undefined);
            assert.strictEqual(await manager.get(uri), undefined);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: undefined });
        });

        test('lets a replacement win while warm validation awaits sidecar proof', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const replacementEnvironment = await createOwnedEnvironment('fedcba9876543210');
            await manager.set(uri, oldEnvironment);
            const validationManager = manager as unknown as {
                currentCacheEntryProvesSourceMetadataIdentity(
                    candidate: PythonEnvironment,
                    metadataIdentity: string,
                    metadata: metadataReader.InlineScriptMetadata,
                ): Promise<boolean>;
            };
            let resolveProof: ((value: boolean) => void) | undefined;
            const proofStub = sinon.stub(validationManager, 'currentCacheEntryProvesSourceMetadataIdentity').callThrough();
            proofStub.onFirstCall().returns(
                new Promise<boolean>((resolve) => {
                    resolveProof = resolve;
                }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const pendingGet = manager.get(uri);
            await waitForStubCall(proofStub);
            await manager.set(uri, replacementEnvironment);
            resolveProof!(true);

            assert.strictEqual(await pendingGet, replacementEnvironment);
            assert.strictEqual(await manager.get(uri), replacementEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(replacementEnvironment.environmentPath.fsPath),
            });
            sinon.assert.calledOnceWithExactly(listener, {
                uri,
                old: oldEnvironment,
                new: replacementEnvironment,
            });
        });

        test('coalesces concurrent validation of an expired warm association', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            await manager.set(uri, environment);
            const rebuilt = {
                ...environment,
                envId: { ...environment.envId, id: 'rebuilt' },
                version: '3.13.1',
            };
            let resolveValidation: ((value: PythonEnvironment) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment>((resolve) => {
                        resolveValidation = resolve;
                    }),
            );
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const first = manager.get(uri);
            const second = manager.get(uri);
            await waitForStubCall(resolveVenvStub);
            resolveValidation!(rebuilt);

            assert.deepStrictEqual(await Promise.all([first, second]), [rebuilt, rebuilt]);
            assert.strictEqual(resolveVenvStub.callCount, 1);
            sinon.assert.calledOnceWithExactly(listener, { uri, old: environment, new: rebuilt });
        });

        test('lets an explicit selection win while warm validation awaits filesystem inspection', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const selectedEnvironment = await createOwnedEnvironment('fedcba9876543210');
            await manager.set(uri, oldEnvironment);
            const rebuiltOldEnvironment = {
                ...oldEnvironment,
                envId: { ...oldEnvironment.envId, id: 'rebuilt-old' },
                version: '3.13.1',
            };
            resolveVenvStub.resolves(rebuiltOldEnvironment);
            let releaseBusyCheck: (() => void) | undefined;
            const busyCheckGate = new Promise<boolean>((resolve) => {
                releaseBusyCheck = () => resolve(false);
            });
            const validationManager = manager as unknown as {
                isCacheEntryBusy(envDirPath: string): Promise<boolean>;
            };
            const busyCheckStub = sinon.stub(validationManager, 'isCacheEntryBusy').callThrough();
            busyCheckStub.onFirstCall().returns(busyCheckGate);
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            clock.tick(5_000);

            const pendingGet = manager.get(uri);
            await waitForStubCall(busyCheckStub);
            await manager.set(uri, selectedEnvironment);
            releaseBusyCheck!();

            assert.strictEqual(await pendingGet, selectedEnvironment);
            assert.strictEqual(await manager.get(uri), selectedEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(selectedEnvironment.environmentPath.fsPath),
            });
            assert.strictEqual(resolveVenvStub.callCount, 0);
            sinon.assert.calledOnceWithExactly(listener, {
                uri,
                old: oldEnvironment,
                new: selectedEnvironment,
            });
        });

        test('unsets a persisted association after transient rehydration failure', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 1);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(listener.callCount, 1);

            resolveVenvStub.resetHistory();
            assert.strictEqual(await manager.get(uri), undefined);
            assert.strictEqual(resolveVenvStub.callCount, 0);
        });

        test('removes definitively stale or corrupt persisted paths but preserves transient resolution failures', async () => {
            const staleUri = scriptUri('stale.py');
            persistedAssociations = { [normalizePath(staleUri.fsPath)]: path.join(tempRoot, 'missing-python') };

            assert.strictEqual(await manager.get(staleUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            const corruptUri = scriptUri('corrupt.py');
            persistedAssociations = { [normalizePath(corruptUri.fsPath)]: 'not-an-absolute-path' };
            assert.strictEqual(await manager.get(corruptUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            const transientUri = scriptUri('transient.py');
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(transientUri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves(undefined);

            assert.strictEqual(await manager.get(transientUri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(transientUri.fsPath)]: environment.environmentPath.fsPath,
            });

            persistedAssociations = ['corrupt state'];
            assert.strictEqual(await manager.get(scriptUri('corrupt-state.py')), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
        });

        test('does not let stale corrupt-state repair delete a newer valid association', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const scriptPath = normalizePath(uri.fsPath);
            persistedAssociations = { [scriptPath]: 42 };
            let envKeyReads = 0;
            workspaceState.get.callsFake(async (key: string) => {
                if (key === INLINE_SCRIPT_ENVS_KEY) {
                    envKeyReads += 1;
                    if (envKeyReads === 1) {
                        return { [scriptPath]: 42 };
                    }
                    persistedAssociations = { [scriptPath]: matchedAssociationRecord(environment.environmentPath.fsPath) };
                    return persistedAssociations;
                }
                return undefined;
            });

            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [scriptPath]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
        });

        test('preserves an association when fallback resolution reports another manager', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };
            resolveVenvStub.resolves({
                ...environment,
                envId: { ...environment.envId, managerId: 'ms-python.python:system' },
            });

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath,
            });
            assert.strictEqual(workspaceState.set.callCount, 0);
        });

        test('rejects resolved and selected environments that are outside the owned cache', async () => {
            const uri = scriptUri();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);
            const outsideDir = path.join(tempRoot, 'outside');
            const outsideExecutable = getVenvPythonPath(outsideDir);
            await fs.outputFile(outsideExecutable, '');
            await fs.ensureDir(cacheLayout.getScriptEnvCacheRoot(globalStorageUri).fsPath);
            const unowned = makeEnvironment(
                'ms-python.python:inline-script',
                '3.12.4',
                outsideExecutable,
                outsideDir,
            );
            persistedAssociations = { [normalizePath(uri.fsPath)]: outsideExecutable };
            resolveVenvStub.resolves(unowned);

            assert.strictEqual(await manager.get(uri), undefined);
            assert.deepStrictEqual(persistedAssociations, {});
            workspaceState.set.resetHistory();

            await assert.rejects(manager.set(uri, unowned), /not an owned cache entry/);
            assert.deepStrictEqual(persistedAssociations, {});
            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(listener.callCount, 0);
        });

        test('normalizes script paths and treats same-ID environments at different paths as different selections', async function () {
            if (!isWindows()) {
                this.skip();
            }
            const uri = scriptUri('CaseSensitive.py');
            const differentlyCased = Uri.file(uri.fsPath.toUpperCase());
            const first = await createOwnedEnvironment(CACHE_KEY, 'duplicate-id');
            const second = await createOwnedEnvironment('fedcba9876543210', 'duplicate-id');
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, first);
            assert.strictEqual(await manager.get(differentlyCased), first);

            await manager.set(differentlyCased, second);
            assert.strictEqual(await manager.get(uri), second);
            assert.strictEqual(listener.callCount, 2);
            assert.strictEqual(listener.secondCall.args[0].uri, differentlyCased);
            assert.strictEqual(listener.secondCall.args[0].old, first);
            assert.strictEqual(listener.secondCall.args[0].new, second);
        });

        test('keeps the prior in-memory association and emits no event when persistence fails', async () => {
            const uri = scriptUri();
            const first = await createOwnedEnvironment();
            const second = await createOwnedEnvironment('fedcba9876543210');
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, first);
            workspaceState.set.onSecondCall().rejects(new Error('Memento unavailable'));
            await assert.rejects(manager.set(uri, second), /Memento unavailable/);

            assert.strictEqual(await manager.get(uri), first);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(first.environmentPath.fsPath),
            });
            assert.strictEqual(listener.callCount, 1);
        });

        test('rejects a failed unset without changing its in-memory association or firing an event', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            await manager.set(uri, environment);
            workspaceState.set.onSecondCall().rejects(new Error('Memento unavailable'));

            await assert.rejects(manager.set(uri, undefined), /Memento unavailable/);
            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(listener.callCount, 1);
        });

        test('does not block a cached lookup behind another script rehydration', async () => {
            const slowUri = scriptUri('slow.py');
            const cachedUri = scriptUri('cached.py');
            const slowEnvironment = await createOwnedEnvironment();
            const cachedEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = { [normalizePath(slowUri.fsPath)]: slowEnvironment.environmentPath.fsPath };
            await manager.set(cachedUri, cachedEnvironment);

            let resolveSlow: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolveSlow = resolve;
                    }),
            );
            const slowGet = manager.get(slowUri);
            await waitForStubCall(resolveVenvStub);

            const cachedResult = await Promise.race([
                manager.get(cachedUri).then((value) => ({ kind: 'cached' as const, value })),
                nextTurn().then(() => ({ kind: 'blocked' as const, value: undefined })),
            ]);
            assert.strictEqual(cachedResult.kind, 'cached');
            assert.strictEqual(cachedResult.value, cachedEnvironment);

            resolveSlow!(slowEnvironment);
            assert.strictEqual(await slowGet, slowEnvironment);
        });

        test('lets an unset win over a pending stale rehydration', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            await manager.set(uri, undefined);
            assert.deepStrictEqual(persistedAssociations, {});

            resolvePending!(environment);
            assert.strictEqual(await pendingGet, undefined);
            assert.strictEqual(await manager.get(uri), undefined);
        });

        test('lets a same-path selection supersede a pending stale rehydration', async () => {
            const uri = scriptUri();
            const environment = await createOwnedEnvironment();
            persistedAssociations = { [normalizePath(uri.fsPath)]: environment.environmentPath.fsPath };

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            await manager.set(uri, environment);
            const stale = {
                ...environment,
                envId: { ...environment.envId, managerId: 'ms-python.python:system' },
            };
            resolvePending!(stale);

            assert.strictEqual(await pendingGet, environment);
            assert.strictEqual(await manager.get(uri), environment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: matchedAssociationRecord(environment.environmentPath.fsPath),
            });
            assert.strictEqual(workspaceStateSetCalls(INLINE_SCRIPT_ENVS_KEY).length, 1);
        });

        test('retains a pending rehydration when a competing persistence write fails', async () => {
            const uri = scriptUri();
            const oldEnvironment = await createOwnedEnvironment();
            const newEnvironment = await createOwnedEnvironment('fedcba9876543210');
            persistedAssociations = { [normalizePath(uri.fsPath)]: oldEnvironment.environmentPath.fsPath };
            const listener = sinon.spy();
            manager.onDidChangeEnvironment(listener);

            let resolvePending: ((value: PythonEnvironment | undefined) => void) | undefined;
            resolveVenvStub.callsFake(
                () =>
                    new Promise<PythonEnvironment | undefined>((resolve) => {
                        resolvePending = resolve;
                    }),
            );
            const pendingGet = manager.get(uri);
            await waitForStubCall(resolveVenvStub);

            workspaceState.set.onFirstCall().rejects(new Error('Memento unavailable'));
            await assert.rejects(manager.set(uri, newEnvironment), /Memento unavailable/);

            resolvePending!(oldEnvironment);
            assert.strictEqual(await pendingGet, oldEnvironment);
            assert.strictEqual(await manager.get(uri), oldEnvironment);
            assert.deepStrictEqual(persistedAssociations, {
                [normalizePath(uri.fsPath)]: oldEnvironment.environmentPath.fsPath,
            });
            sinon.assert.calledOnceWithExactly(listener, { uri, old: undefined, new: oldEnvironment });
        });

        test('rejects invalid scopes atomically and never writes workspace state', async () => {
            const environment = await createOwnedEnvironment();
            const valid = scriptUri();

            await assert.rejects(manager.set(undefined, environment), /one or more local file URIs/);
            await assert.rejects(manager.set(Uri.parse('untitled:script.py'), environment), /one or more local file URIs/);
            await assert.rejects(
                manager.set([valid, Uri.parse('untitled:script.py')], environment),
                /one or more local file URIs/,
            );

            assert.strictEqual(workspaceState.set.callCount, 0);
            assert.strictEqual(await manager.get(valid), undefined);
            assert.strictEqual(await manager.get(undefined), undefined);
            assert.strictEqual(await manager.get(Uri.parse('untitled:script.py')), undefined);
        });
    });
});
