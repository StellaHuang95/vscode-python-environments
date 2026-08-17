import * as assert from 'assert';
import * as sinon from 'sinon';
import * as typeMoq from 'typemoq';
import { Disposable, EventEmitter, Uri } from 'vscode';
import { PythonEnvironment, PythonProject } from '../../api';
import * as commandApi from '../../common/command.api';
import { INLINE_SCRIPT_MANAGER_ID } from '../../common/constants';
import * as inlineScriptMetadata from '../../common/inlineScript/metadata';
import * as extensionApis from '../../common/extension.apis';
import * as managerApi from '../../common/pickers/managers';
import * as projectApi from '../../common/pickers/projects';
import * as logging from '../../common/logging';
import * as telemetrySender from '../../common/telemetry/sender';
import * as platformUtils from '../../common/utils/platformUtils';
import * as windowApis from '../../common/window.apis';
import * as workspaceApis from '../../common/workspace.apis';
import * as helpers from '../../helpers';
import {
    _resetManagerReadyForTesting,
    createManagerReady,
    MANAGER_READY_TIMEOUT_MS,
} from '../../features/common/managerReady';
import * as managerReady from '../../features/common/managerReady';
import {
    clearScriptEnvironmentCacheCommand,
    createAnyEnvironmentCommand,
    removePythonProject,
    revealEnvInManagerView,
    setupInlineScriptEnvironmentCommand,
} from '../../features/envCommands';
import * as settingHelpers from '../../features/settings/settingHelpers';
import { EnvManagerView } from '../../features/views/envManagersView';
import { ProjectEnvironment, ProjectItem } from '../../features/views/treeViewItems';
import {
    DidChangeEnvironmentManagerEventArgs,
    EnvironmentManagers,
    InternalEnvironmentManager,
    PythonProjectManager,
} from '../../internal.api';
import { setupNonThenable } from '../mocks/helper';

suite('Create Any Environment Command Tests', () => {
    let em: typeMoq.IMock<EnvironmentManagers>;
    let pm: typeMoq.IMock<PythonProjectManager>;
    let manager: typeMoq.IMock<InternalEnvironmentManager>;
    let env: typeMoq.IMock<PythonEnvironment>;
    let pickProjectManyStub: sinon.SinonStub;
    let pickEnvironmentManagerStub: sinon.SinonStub;
    let project: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder'),
        name: 'test-folder',
    };
    let project2: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder2'),
        name: 'test-folder2',
    };
    let project3: PythonProject = {
        uri: Uri.file('/some/test/workspace/folder3'),
        name: 'test-folder3',
    };

    setup(() => {
        manager = typeMoq.Mock.ofType<InternalEnvironmentManager>();
        manager.setup((m) => m.id).returns(() => 'test');
        manager.setup((m) => m.displayName).returns(() => 'Test Manager');
        manager.setup((m) => m.description).returns(() => 'Test Manager Description');
        manager.setup((m) => m.supportsCreate).returns(() => true);

        env = typeMoq.Mock.ofType<PythonEnvironment>();
        env.setup((e) => e.envId).returns(() => ({ id: 'env1', managerId: 'test' }));
        setupNonThenable(env);

        em = typeMoq.Mock.ofType<EnvironmentManagers>();
        em.setup((e) => e.managers).returns(() => [manager.object]);
        em.setup((e) => e.getEnvironmentManager(typeMoq.It.isAnyString())).returns(() => manager.object);

        pm = typeMoq.Mock.ofType<PythonProjectManager>();

        pickEnvironmentManagerStub = sinon.stub(managerApi, 'pickEnvironmentManager');
        pickProjectManyStub = sinon.stub(projectApi, 'pickProjectMany');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Create global venv (no-workspace): no-select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });
        // Add assertions to verify the result
        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
    });

    test('Create global venv (no-workspace): select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => []);
        manager
            .setup((m) => m.create('global', typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(undefined, env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });
        // Add assertions to verify the result
        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
    });

    test('Create workspace venv: no-select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        manager
            .setup((m) => m.create([project.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: false });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create workspace venv: select', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project]);
        manager
            .setup((m) => m.create([project.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri], env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create multi-workspace venv: select all', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project, project2, project3]);
        manager
            .setup((m) => m.create([project.uri, project2.uri, project3.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri, project2.uri, project3.uri], env.object)).verifiable(
            typeMoq.Times.once(),
        );

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project, project2, project3]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });

    test('Create multi-workspace venv: select some', async () => {
        pm.setup((p) => p.getProjects(typeMoq.It.isAny())).returns(() => [project, project2, project3]);
        manager
            .setup((m) => m.create([project.uri, project3.uri], typeMoq.It.isAny()))
            .returns(() => Promise.resolve(env.object))
            .verifiable(typeMoq.Times.once());

        // This is a case where env managers handler does this in batch to avoid writing to files for each case
        manager.setup((m) => m.set(typeMoq.It.isAny(), typeMoq.It.isAny())).verifiable(typeMoq.Times.never());
        em.setup((e) => e.setEnvironments([project.uri, project3.uri], env.object)).verifiable(typeMoq.Times.once());

        pickEnvironmentManagerStub.resolves(manager.object.id);
        pickProjectManyStub.resolves([project, project3]);

        const result = await createAnyEnvironmentCommand(em.object, pm.object, { selectEnvironment: true });

        assert.strictEqual(result, env.object, 'Expected the created environment to match the mocked environment.');
        manager.verifyAll();
        em.verifyAll();
    });
});

suite('Remove Python Project Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('clears the active environment before removing the project', async () => {
        const calls: string[] = [];
        const project: PythonProject = {
            uri: Uri.file('/some/test/workspace/project'),
            name: 'project',
        };
        const item = new ProjectItem(project);
        const envManagers = {
            setEnvironment: sinon.stub().callsFake(async () => {
                calls.push('clearEnvironment');
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            remove: sinon.stub().callsFake(() => {
                calls.push('removeProject');
            }),
        } as unknown as PythonProjectManager;
        sinon.stub(settingHelpers, 'removePythonProjectSetting').callsFake(async () => {
            calls.push('removeSetting');
        });

        await removePythonProject(item, projectManager, envManagers);

        assert.deepStrictEqual(calls, ['clearEnvironment', 'removeSetting', 'removeProject']);
        assert.ok(
            (envManagers.setEnvironment as sinon.SinonStub).calledOnceWithExactly(project.uri, undefined),
            'Should clear the project environment through the central manager',
        );
    });
});

suite('Clear Script Environment Cache Command Tests', () => {
    teardown(() => {
        sinon.restore();
    });

    test('cancels without clearing the cache or touching project settings', async () => {
        const clearCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves(undefined);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.notCalled(clearCache);
        sinon.assert.notCalled(removeInlineSettings);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });

    test('clears cache before inline settings cleanup and unloads removed projects', async () => {
        const calls: string[] = [];
        const inlineProject: PythonProject = {
            uri: Uri.file('/workspace/script.py'),
            name: 'script.py',
        };
        const clearCache = sinon.stub().callsFake(async () => {
            calls.push('clearCache');
        });
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().callsFake(() => {
                calls.push('getProjects');
                return [inlineProject];
            }),
            remove: sinon.stub().callsFake(() => {
                calls.push('removeProjects');
            }),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon
            .stub(settingHelpers, 'removeInlineScriptPythonProjectSettings')
            .callsFake(async (projects) => {
                calls.push('removeInlineSettings');
                assert.deepStrictEqual(projects, [inlineProject]);
                return [inlineProject];
            });

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.calledOnce(removeInlineSettings);
        sinon.assert.calledOnceWithExactly(projectManager.remove as sinon.SinonStub, [inlineProject]);
        assert.deepStrictEqual(calls, ['clearCache', 'getProjects', 'removeInlineSettings', 'removeProjects']);
    });

    test('keeps loaded projects when inline settings cleanup leaves them configured', async () => {
        const inlineProject: PythonProject = {
            uri: Uri.file('/workspace/runner'),
            name: 'runner',
        };
        const clearCache = sinon.stub().resolves();
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([inlineProject]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await clearScriptEnvironmentCacheCommand(envManagers, projectManager);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.calledOnceWithExactly(removeInlineSettings, [inlineProject]);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });

    test('preserves project settings when cache cleanup reports a partial failure', async () => {
        const clearCache = sinon.stub().rejects(new Error('one cache entry could not be deleted'));
        const envManagers = {
            getEnvironmentManager: sinon.stub().withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
                supportsClearCache: () => true,
                clearCache,
            }),
        } as unknown as EnvironmentManagers;
        const projectManager = {
            getProjects: sinon.stub().returns([]),
            remove: sinon.stub(),
        } as unknown as PythonProjectManager;
        sinon.stub(windowApis, 'showWarningMessage').resolves('Clear Cache' as never);
        const removeInlineSettings = sinon.stub(settingHelpers, 'removeInlineScriptPythonProjectSettings').resolves([]);

        await assert.rejects(clearScriptEnvironmentCacheCommand(envManagers, projectManager), /could not be deleted/);

        sinon.assert.calledOnce(clearCache);
        sinon.assert.notCalled(removeInlineSettings);
        sinon.assert.notCalled(projectManager.remove as sinon.SinonStub);
    });
});

suite('Reveal Env In Manager View Command Tests', () => {
    let managerView: typeMoq.IMock<EnvManagerView>;
    let executeCommandStub: sinon.SinonStub;

    setup(() => {
        managerView = typeMoq.Mock.ofType<EnvManagerView>();
        setupNonThenable(managerView);
        executeCommandStub = sinon.stub(commandApi, 'executeCommand');
    });

    teardown(() => {
        sinon.restore();
    });

    test('Focuses env-managers view and reveals environment when given a ProjectEnvironment', async () => {
        // Mock
        const project: PythonProject = {
            uri: Uri.file('/test/project'),
            name: 'test-project',
        };
        const projectItem = new ProjectItem(project);

        const environment: PythonEnvironment = {
            envId: { id: 'test-env-id', managerId: 'test-manager' },
            name: 'test-env',
            displayName: 'Test Environment',
            displayPath: '/path/to/env',
            version: '3.10.0',
            environmentPath: Uri.file('/path/to/env'),
            execInfo: { run: { executable: '/path/to/python' }, activatedRun: { executable: '/path/to/python' } },
            sysPrefix: '/path/to/env',
        };
        const projectEnv = new ProjectEnvironment(projectItem, environment);

        executeCommandStub.resolves();
        managerView.setup((m) => m.reveal(environment)).returns(() => Promise.resolve());

        // Run
        await revealEnvInManagerView(projectEnv, managerView.object);

        // Assert
        assert.ok(executeCommandStub.calledOnceWith('env-managers.focus'), 'Should focus the env-managers view');
        managerView.verify((m) => m.reveal(environment), typeMoq.Times.once());
    });
});

suite('Setup Inline Script Environment Command Tests', () => {
    let createStub: sinon.SinonStub;
    let getEnvironmentManagerStub: sinon.SinonStub;
    let setEnvironmentStub: sinon.SinonStub;
    let activeTextEditorStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let getOpenTextDocumentsStub: sinon.SinonStub;
    let readInlineScriptMetadataStub: sinon.SinonStub;
    let isInlineScriptsFeatureEnabledStub: sinon.SinonStub;
    let waitForEnvManagerIdStub: sinon.SinonStub;

    function createEnvironment(): PythonEnvironment {
        return {
            envId: { id: 'inline-env', managerId: INLINE_SCRIPT_MANAGER_ID },
            name: 'inline-env',
            displayName: 'Inline Environment',
            displayPath: '/path/to/inline-env',
            version: '3.12.0',
            environmentPath: Uri.file('/path/to/inline-env'),
            execInfo: { run: { executable: '/path/to/inline-env/python' } },
            sysPrefix: '/path/to/inline-env',
        };
    }

    function createDocument(uri: Uri, isDirty = false) {
        return { uri, isDirty } as { uri: Uri; isDirty: boolean };
    }

    function createManagers(): EnvironmentManagers {
        return {
            getEnvironmentManager: getEnvironmentManagerStub,
            setEnvironment: setEnvironmentStub,
        } as unknown as EnvironmentManagers;
    }

    function registerInlineManager(): void {
        getEnvironmentManagerStub.withArgs(INLINE_SCRIPT_MANAGER_ID).returns({
            create: createStub,
        } as unknown as InternalEnvironmentManager);
    }

    setup(() => {
        createStub = sinon.stub();
        getEnvironmentManagerStub = sinon.stub();
        setEnvironmentStub = sinon.stub().resolves();
        activeTextEditorStub = sinon.stub(windowApis, 'activeTextEditor').returns(undefined);
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        getOpenTextDocumentsStub = sinon.stub(workspaceApis, 'getOpenTextDocuments').returns([]);
        readInlineScriptMetadataStub = sinon
            .stub(inlineScriptMetadata, 'readInlineScriptMetadataFromFile')
            .resolves({ range: { start: 0, end: 0 } });
        isInlineScriptsFeatureEnabledStub = sinon.stub(helpers, 'isInlineScriptsFeatureEnabled').returns(true);
        waitForEnvManagerIdStub = sinon.stub(managerReady, 'waitForEnvManagerId').resolves();
    });

    teardown(() => {
        sinon.restore();
    });

    test('uses the supplied uri and sets the created environment without persisting settings', async () => {
        const uri = Uri.file('/workspace/script.py');
        const activeUri = Uri.file('/workspace/other.py');
        activeTextEditorStub.returns({ document: createDocument(activeUri) });
        getOpenTextDocumentsStub.returns([createDocument(uri)]);
        const environment = createEnvironment();
        registerInlineManager();
        createStub.resolves(environment);

        const result = await setupInlineScriptEnvironmentCommand(uri, createManagers());

        assert.strictEqual(result, environment);
        sinon.assert.calledOnceWithExactly(readInlineScriptMetadataStub, uri);
        sinon.assert.calledOnceWithExactly(waitForEnvManagerIdStub, [INLINE_SCRIPT_MANAGER_ID]);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.calledOnceWithExactly(setEnvironmentStub, uri, environment, false);
        sinon.assert.notCalled(showErrorMessageStub);
    });

    test('falls back to the active editor when no uri is supplied', async () => {
        const uri = Uri.file('/workspace/active.py');
        activeTextEditorStub.returns({ document: createDocument(uri) });
        const environment = createEnvironment();
        registerInlineManager();
        createStub.resolves(environment);

        const result = await setupInlineScriptEnvironmentCommand(undefined, createManagers());

        assert.strictEqual(result, environment);
        sinon.assert.calledOnceWithExactly(readInlineScriptMetadataStub, uri);
        sinon.assert.calledOnceWithExactly(waitForEnvManagerIdStub, [INLINE_SCRIPT_MANAGER_ID]);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.calledOnceWithExactly(setEnvironmentStub, uri, environment, false);
    });

    test('shows an error when no active editor is available', async () => {
        await setupInlineScriptEnvironmentCommand(undefined, createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /Open or select a saved local \.py file/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('rejects non-file uris', async () => {
        await setupInlineScriptEnvironmentCommand(Uri.parse('untitled:script.py'), createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /requires a local \.py file/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('rejects non-python files', async () => {
        await setupInlineScriptEnvironmentCommand(Uri.file('/workspace/script.txt'), createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /requires a local \.py file/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('requires dirty documents to be saved first', async () => {
        const uri = Uri.file('/workspace/script.py');
        getOpenTextDocumentsStub.returns([createDocument(uri, true)]);

        await setupInlineScriptEnvironmentCommand(uri, createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /Save the file before setting up/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('matches equivalent Windows file uris when checking for a dirty open document', async () => {
        const uri = Uri.file('/workspace/package/script.py');
        const equivalentOpenUri = {
            scheme: 'file',
            fsPath: '\\WORKSPACE\\package\\script.py',
            toString: () => 'file:///WORKSPACE%5Cpackage%5Cscript.py',
        } as unknown as Uri;
        sinon.stub(platformUtils, 'isWindows').returns(true);
        getOpenTextDocumentsStub.returns([createDocument(equivalentOpenUri, true)]);

        await setupInlineScriptEnvironmentCommand(uri, createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /Save the file before setting up/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('requires valid saved PEP 723 metadata', async () => {
        const uri = Uri.file('/workspace/script.py');
        readInlineScriptMetadataStub.resolves(undefined);

        await setupInlineScriptEnvironmentCommand(uri, createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /valid PEP 723 inline script metadata/);
        sinon.assert.calledOnceWithExactly(readInlineScriptMetadataStub, uri);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
    });

    test('shows the feature-disabled error before dirty, metadata, or readiness checks', async () => {
        const uri = Uri.file('/workspace/script.py');
        getOpenTextDocumentsStub.returns([createDocument(uri, true)]);
        isInlineScriptsFeatureEnabledStub.returns(false);

        await setupInlineScriptEnvironmentCommand(uri, createManagers());

        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /python-envs\.inlineScripts\.enabled/);
        sinon.assert.notCalled(readInlineScriptMetadataStub);
        sinon.assert.notCalled(waitForEnvManagerIdStub);
        sinon.assert.notCalled(createStub);
        sinon.assert.notCalled(setEnvironmentStub);
    });

    test('leaves the existing association unchanged when setup is cancelled', async () => {
        const uri = Uri.file('/workspace/script.py');
        registerInlineManager();
        createStub.resolves(undefined);

        const result = await setupInlineScriptEnvironmentCommand(uri, createManagers());

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(waitForEnvManagerIdStub, [INLINE_SCRIPT_MANAGER_ID]);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.notCalled(setEnvironmentStub);
        sinon.assert.notCalled(showErrorMessageStub);
    });

    test('propagates create errors', async () => {
        const uri = Uri.file('/workspace/script.py');
        registerInlineManager();
        createStub.rejects(new Error('create failed'));

        await assert.rejects(setupInlineScriptEnvironmentCommand(uri, createManagers()), /create failed/);

        sinon.assert.calledOnceWithExactly(waitForEnvManagerIdStub, [INLINE_SCRIPT_MANAGER_ID]);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.notCalled(setEnvironmentStub);
    });

    test('propagates set errors', async () => {
        const uri = Uri.file('/workspace/script.py');
        const environment = createEnvironment();
        registerInlineManager();
        createStub.resolves(environment);
        setEnvironmentStub.rejects(new Error('set failed'));

        await assert.rejects(setupInlineScriptEnvironmentCommand(uri, createManagers()), /set failed/);

        sinon.assert.calledOnceWithExactly(waitForEnvManagerIdStub, [INLINE_SCRIPT_MANAGER_ID]);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.calledOnceWithExactly(setEnvironmentStub, uri, environment, false);
    });

    test('re-runs setup on repeated invocation so metadata changes can affect the cache key', async () => {
        const uri = Uri.file('/workspace/script.py');
        const environment = createEnvironment();
        registerInlineManager();
        createStub.resolves(environment);

        await setupInlineScriptEnvironmentCommand(uri, createManagers());
        await setupInlineScriptEnvironmentCommand(uri, createManagers());

        sinon.assert.calledTwice(readInlineScriptMetadataStub);
        sinon.assert.calledTwice(waitForEnvManagerIdStub);
        sinon.assert.calledTwice(createStub);
        sinon.assert.calledTwice(setEnvironmentStub);
        assert.deepStrictEqual(createStub.firstCall.args, [uri, undefined]);
        assert.deepStrictEqual(createStub.secondCall.args, [uri, undefined]);
        assert.deepStrictEqual(setEnvironmentStub.firstCall.args, [uri, environment, false]);
        assert.deepStrictEqual(setEnvironmentStub.secondCall.args, [uri, environment, false]);
    });
});

suite('Setup Inline Script Environment Command Manager Readiness Tests', () => {
    let clock: sinon.SinonFakeTimers;
    let envManagerEmitter: EventEmitter<DidChangeEnvironmentManagerEventArgs>;
    let disposables: Disposable[];
    let createStub: sinon.SinonStub;
    let getEnvironmentManagerStub: sinon.SinonStub;
    let setEnvironmentStub: sinon.SinonStub;
    let showErrorMessageStub: sinon.SinonStub;
    let readInlineScriptMetadataStub: sinon.SinonStub;
    let managerAvailable: boolean;

    function createEnvironment(): PythonEnvironment {
        return {
            envId: { id: 'inline-env', managerId: INLINE_SCRIPT_MANAGER_ID },
            name: 'inline-env',
            displayName: 'Inline Environment',
            displayPath: '/path/to/inline-env',
            version: '3.12.0',
            environmentPath: Uri.file('/path/to/inline-env'),
            execInfo: { run: { executable: '/path/to/inline-env/python' } },
            sysPrefix: '/path/to/inline-env',
        };
    }

    function createManagers(): EnvironmentManagers {
        return {
            getEnvironmentManager: getEnvironmentManagerStub,
            setEnvironment: setEnvironmentStub,
            onDidChangeEnvironmentManager: envManagerEmitter.event,
            onDidChangePackageManager: new EventEmitter().event,
        } as unknown as EnvironmentManagers;
    }

    setup(() => {
        clock = sinon.useFakeTimers();
        disposables = [];
        managerAvailable = false;
        envManagerEmitter = new EventEmitter<DidChangeEnvironmentManagerEventArgs>();
        createStub = sinon.stub().resolves(createEnvironment());
        getEnvironmentManagerStub = sinon.stub().callsFake((managerId: string) => {
            if (managerId === INLINE_SCRIPT_MANAGER_ID && managerAvailable) {
                return { create: createStub } as unknown as InternalEnvironmentManager;
            }
            return undefined;
        });
        setEnvironmentStub = sinon.stub().resolves();
        showErrorMessageStub = sinon.stub(windowApis, 'showErrorMessage').resolves(undefined);
        sinon.stub(windowApis, 'activeTextEditor').returns(undefined);
        sinon.stub(workspaceApis, 'getOpenTextDocuments').returns([]);
        readInlineScriptMetadataStub = sinon
            .stub(inlineScriptMetadata, 'readInlineScriptMetadataFromFile')
            .resolves({ range: { start: 0, end: 0 } });
        sinon.stub(helpers, 'isInlineScriptsFeatureEnabled').returns(true);
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceInfo');
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        sinon.stub(extensionApis, 'getExtension').returns({
            id: 'ms-python.python',
            isActive: true,
        } as unknown as ReturnType<typeof extensionApis.getExtension>);

        _resetManagerReadyForTesting();
        createManagerReady(
            {
                onDidChangeEnvironmentManager: envManagerEmitter.event,
                onDidChangePackageManager: new EventEmitter().event,
            } as unknown as EnvironmentManagers,
            { getProjects: () => [] } as unknown as PythonProjectManager,
            disposables,
        );
    });

    teardown(() => {
        clock.restore();
        disposables.forEach((disposable) => disposable.dispose());
        envManagerEmitter.dispose();
        sinon.restore();
        _resetManagerReadyForTesting();
    });

    test('waits for inline manager readiness before direct lookup', async () => {
        const uri = Uri.file('/workspace/script.py');
        let settled = false;

        const resultPromise = setupInlineScriptEnvironmentCommand(uri, createManagers()).then((result) => {
            settled = true;
            return result;
        });

        await clock.tickAsync(0);
        assert.strictEqual(settled, false);
        sinon.assert.notCalled(getEnvironmentManagerStub);
        sinon.assert.notCalled(createStub);

        managerAvailable = true;
        envManagerEmitter.fire({
            kind: 'registered',
            manager: { id: INLINE_SCRIPT_MANAGER_ID } as unknown as InternalEnvironmentManager,
        });

        const result = await resultPromise;

        assert.strictEqual(settled, true);
        assert.strictEqual(result?.envId.managerId, INLINE_SCRIPT_MANAGER_ID);
        sinon.assert.calledOnceWithExactly(readInlineScriptMetadataStub, uri);
        sinon.assert.calledOnceWithExactly(getEnvironmentManagerStub, INLINE_SCRIPT_MANAGER_ID);
        sinon.assert.calledOnceWithExactly(createStub, uri, undefined);
        sinon.assert.calledOnceWithExactly(setEnvironmentStub, uri, result, false);
        sinon.assert.notCalled(showErrorMessageStub);
    });

    test('shows the not-registered error after manager-ready timeout', async () => {
        const uri = Uri.file('/workspace/script.py');

        const resultPromise = setupInlineScriptEnvironmentCommand(uri, createManagers());
        await clock.tickAsync(0);
        clock.tick(MANAGER_READY_TIMEOUT_MS);
        await clock.tickAsync(0);

        const result = await resultPromise;

        assert.strictEqual(result, undefined);
        sinon.assert.calledOnceWithExactly(readInlineScriptMetadataStub, uri);
        sinon.assert.calledOnceWithExactly(getEnvironmentManagerStub, INLINE_SCRIPT_MANAGER_ID);
        sinon.assert.notCalled(createStub);
        sinon.assert.notCalled(setEnvironmentStub);
        sinon.assert.calledOnce(showErrorMessageStub);
        assert.match(String(showErrorMessageStub.firstCall.args[0]), /preview manager is not registered/);
    });
});
