// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
} from '../../../api';
import { normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';

/**
 * Regression coverage for the bug where a single project whose persisted venv path
 * could not be resolved would abort `loadEnvMap`, leaving every subsequent project
 * in a multi-root workspace unmapped and dropping their queued change events.
 *
 * The original line used `return;` instead of `continue;`. The fix preserves
 * iteration so that later projects still get mapped and their change events
 * still fire.
 */

function createMockEnv(envPath: string, idSuffix: string = 'env'): PythonEnvironment {
    return {
        envId: { id: `venv-${idSuffix}`, managerId: 'ms-python.python:venv' },
        name: `venv-${idSuffix}`,
        displayName: `venv (${idSuffix})`,
        version: '3.11.0',
        displayPath: envPath,
        environmentPath: Uri.file(envPath),
        sysPrefix: envPath,
        execInfo: { run: { executable: envPath } },
    };
}

function createMockApi(projects: PythonProject[]): sinon.SinonStubbedInstance<PythonEnvironmentApi> {
    return {
        getPythonProjects: sinon.stub().returns(projects),
        getPythonProject: sinon.stub().callsFake((uri: Uri) => {
            const target = normalizePath(uri.fsPath);
            return projects.find((p) => normalizePath(p.uri.fsPath) === target);
        }),
        createPythonEnvironmentItem: sinon.stub(),
    } as unknown as sinon.SinonStubbedInstance<PythonEnvironmentApi>;
}

function createMockNativeFinder(): sinon.SinonStubbedInstance<NativePythonFinder> {
    return {
        resolve: sinon.stub(),
        refresh: sinon.stub().resolves([]),
    } as unknown as sinon.SinonStubbedInstance<NativePythonFinder>;
}

function createMockLog(): sinon.SinonStubbedInstance<import('vscode').LogOutputChannel> {
    return {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
        debug: sinon.stub(),
        trace: sinon.stub(),
        append: sinon.stub(),
        appendLine: sinon.stub(),
        clear: sinon.stub(),
        show: sinon.stub(),
        hide: sinon.stub(),
        dispose: sinon.stub(),
        replace: sinon.stub(),
        name: 'test-log',
        logLevel: 2,
        onDidChangeLogLevel: sinon.stub() as unknown as import('vscode').Event<import('vscode').LogLevel>,
    } as unknown as sinon.SinonStubbedInstance<import('vscode').LogOutputChannel>;
}

function createMockBaseManager(): EnvironmentManager {
    return {
        getEnvironments: sinon.stub().resolves([]),
    } as unknown as EnvironmentManager;
}

suite('VenvManager.loadEnvMap multi-project resilience', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        // Make `withProgress` synchronous so we don't depend on real VS Code progress UI.
        sandbox.stub(windowApis, 'withProgress').callsFake((_opts, cb) => cb(undefined as never, undefined as never));
        // loadGlobalEnv reads getVenvForGlobal; default to "no persisted global selection".
        sandbox.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        // findVirtualEnvironments populates the manager's collection during internalRefresh.
        // Tests override this stub when they need specific envs in the collection.
        sandbox.stub(venvUtils, 'findVirtualEnvironments').resolves([]);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('a project whose persisted env fails to resolve does not skip mapping for later projects', async () => {
        // Two projects. The first one has a persisted env path that is unknown to
        // the collection AND fails to resolve (e.g. stale or broken). The second
        // one has a valid persisted env that exists in the collection.
        const projectAUri = Uri.file(path.resolve('projA'));
        const projectBUri = Uri.file(path.resolve('projB'));
        const projectA: PythonProject = { uri: projectAUri } as PythonProject;
        const projectB: PythonProject = { uri: projectBUri } as PythonProject;

        const stalePathA = path.resolve('projA', '.venv-stale');
        const validPathB = path.resolve('projB', '.venv');

        const envB = createMockEnv(validPathB, 'B');

        // Persisted state: each project points at a different env path.
        const getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace');
        getVenvStub.withArgs(projectAUri.fsPath).resolves(stalePathA);
        getVenvStub.withArgs(projectBUri.fsPath).resolves(validPathB);

        // Only envB ends up in the collection. projectA's path is not present, so
        // findEnvironmentByPath returns undefined for it and resolveVenvPythonEnvironmentPath
        // is called as a fallback — and we make that fail to trigger the bug path.
        (venvUtils.findVirtualEnvironments as sinon.SinonStub).resolves([envB]);
        sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);

        const api = createMockApi([projectA, projectB]);
        const manager = new VenvManager(createMockNativeFinder(), api, createMockBaseManager(), createMockLog());

        const events: DidChangeEnvironmentEventArgs[] = [];
        manager.onDidChangeEnvironment((e) => events.push(e));

        await manager.initialize();

        // projectB MUST be mapped. Before the fix, the early `return` after projectA's
        // failed resolve aborted the loop and projectB silently lost its mapping.
        const envsForB = await manager.getEnvironments(projectBUri);
        assert.strictEqual(envsForB.length, 1, 'projectB should have its env mapped despite projectA failing');
        assert.strictEqual(envsForB[0].envId.id, envB.envId.id, 'projectB should be mapped to envB');

        // projectA correctly has no mapping because its resolve failed.
        const envsForA = await manager.getEnvironments(projectAUri);
        assert.strictEqual(envsForA.length, 0, 'projectA should remain unmapped after failed resolve');

        // The queued change event for projectB MUST fire. Before the fix it was
        // suppressed because events.forEach() was unreachable after `return`.
        const eventB = events.find((e) => e.uri && normalizePath(e.uri.fsPath) === normalizePath(projectBUri.fsPath));
        assert.ok(eventB, 'projectB should have received an onDidChangeEnvironment event');
        assert.strictEqual(eventB!.new?.envId.id, envB.envId.id, 'event should carry envB as the new env');
    });

    test('order independence: failing project as last entry still maps earlier projects (control case)', async () => {
        // Inverse ordering of the bug repro: failing project comes LAST. This case
        // worked even before the fix, so it acts as a control to confirm the test
        // harness itself is sound.
        const projectBUri = Uri.file(path.resolve('projB'));
        const projectAUri = Uri.file(path.resolve('projA'));
        const projectB: PythonProject = { uri: projectBUri } as PythonProject;
        const projectA: PythonProject = { uri: projectAUri } as PythonProject;

        const validPathB = path.resolve('projB', '.venv');
        const stalePathA = path.resolve('projA', '.venv-stale');

        const envB = createMockEnv(validPathB, 'B');

        const getVenvStub = sandbox.stub(venvUtils, 'getVenvForWorkspace');
        getVenvStub.withArgs(projectAUri.fsPath).resolves(stalePathA);
        getVenvStub.withArgs(projectBUri.fsPath).resolves(validPathB);

        (venvUtils.findVirtualEnvironments as sinon.SinonStub).resolves([envB]);
        sandbox.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);

        // projectB iterated first, projectA last.
        const api = createMockApi([projectB, projectA]);
        const manager = new VenvManager(createMockNativeFinder(), api, createMockBaseManager(), createMockLog());

        await manager.initialize();

        const envsForB = await manager.getEnvironments(projectBUri);
        assert.strictEqual(envsForB.length, 1, 'projectB should be mapped regardless of iteration order');
        assert.strictEqual(envsForB[0].envId.id, envB.envId.id);

        const envsForA = await manager.getEnvironments(projectAUri);
        assert.strictEqual(envsForA.length, 0, 'projectA should remain unmapped after failed resolve');
    });
});
