/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import {
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    PythonEnvironment,
    PythonEnvironmentApi,
} from '../../../api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import * as windowApis from '../../../common/window.apis';
import * as envCommands from '../../../features/envCommands';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

const ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-scoped-refresh')).fsPath;
const GLOBAL_ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-scoped-global')).fsPath;

function venvPython(venvRoot: string): string {
    return path.join(venvRoot, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
}

function makeEnv(id: string, venvRoot: string, version?: string): PythonEnvironment {
    return createMockPythonEnvironment({
        name: path.basename(venvRoot),
        envPath: venvPython(venvRoot),
        sysPrefix: venvRoot,
        managerId: VENV_MANAGER_ID,
        id,
        version,
    });
}

function ids(collection: PythonEnvironment[]): string[] {
    return collection.map((e) => e.envId.id).sort();
}

suite('VenvManager - scoped refresh preservation', () => {
    let findVirtualEnvironmentsStub: sinon.SinonStub;
    let findParentIfFileStub: sinon.SinonStub;

    const folderA = path.join(ROOT, 'app');
    const folderB = path.join(ROOT, 'app-2');
    const venvARoot = path.join(folderA, '.venv');
    const venvBRoot = path.join(folderB, '.venv');
    const globalVenvRoot = path.join(GLOBAL_ROOT, 'shared-env');

    function createManager(): VenvManager {
        const api = {
            getEnvironments: sinon.stub().resolves([]),
            getPythonProject: sinon.stub().returns(undefined),
            getPythonProjects: sinon.stub().returns([]),
            refreshEnvironments: sinon.stub().resolves(undefined),
        } as any as PythonEnvironmentApi;
        const baseManager = {
            getEnvironments: sinon.stub().resolves([]),
        } as any as EnvironmentManager;
        const manager = new VenvManager({} as NativePythonFinder, api, baseManager, {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
        } as any);
        (manager as any)._initialized = { promise: Promise.resolve() };
        (manager as any).collection = [];
        return manager;
    }

    function seed(manager: VenvManager, envs: PythonEnvironment[]): void {
        (manager as any).collection = envs;
    }

    function captureEvents(manager: VenvManager): DidChangeEnvironmentsEventArgs[] {
        const events: DidChangeEnvironmentsEventArgs[] = [];
        manager.onDidChangeEnvironments((e) => events.push(e));
        return events;
    }

    function flatChanges(events: DidChangeEnvironmentsEventArgs[]): DidChangeEnvironmentsEventArgs {
        return events.flat();
    }

    setup(() => {
        findVirtualEnvironmentsStub = sinon.stub(venvUtils, 'findVirtualEnvironments');
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        sinon.stub(venvUtils, 'getVenvForWorkspace').resolves(undefined);
        sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);
        findParentIfFileStub = sinon.stub(envCommands, 'findParentIfFile').callsFake(async (p: string) => p);
        sinon
            .stub(windowApis, 'withProgress')
            .callsFake((_options: any, task: any) =>
                task(
                    { report: () => {} },
                    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
                ),
            );
    });

    teardown(() => {
        sinon.restore();
    });

    test('retains siblings and globals while rediscovering the in-scope env', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A-old', venvARoot, '3.11.0');
        const envB = makeEnv('B', venvBRoot);
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envAOld, envB, envGlobal]);

        const envANew = makeEnv('A-new', venvARoot, '3.12.5');
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(collection.includes(envB) && collection.includes(envGlobal));
        assert.ok(collection.includes(envANew) && !collection.includes(envAOld));

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A-old', kind: EnvironmentChangeKind.remove },
                { id: 'A-new', kind: EnvironmentChangeKind.add },
            ],
        );
    });

    test('removes only stale environments inside the target scope', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('A', venvARoot), makeEnv('B', venvBRoot), makeEnv('G', globalVenvRoot)]);
        findVirtualEnvironmentsStub.resolves([]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['B', 'G']);
        const changes = flatChanges(events);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(changes[0].environment.envId.id, 'A');
    });

    test('adds newly discovered environments in the target scope', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'B']);
        const changes = flatChanges(events);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].kind, EnvironmentChangeKind.add);
        assert.strictEqual(changes[0].environment.envId.id, 'A-new');
    });

    test('ignores out-of-scope discovery results (configured global venvFolders) already retained', async () => {
        const manager = createManager();
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envGlobal]);

        const envANew = makeEnv('A-new', venvARoot);
        const envGlobalFresh = makeEnv('G-fresh', globalVenvRoot);
        findVirtualEnvironmentsStub.resolves([envANew, envGlobalFresh]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'G']);
        assert.ok(collection.includes(envGlobal));
        assert.ok(!collection.some((e) => e.envId.id === 'G-fresh'));

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [{ id: 'A-new', kind: EnvironmentChangeKind.add }],
        );
    });

    test('treats sibling directories sharing a name prefix as outside the scope (app vs app-2)', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);
        findVirtualEnvironmentsStub.resolves([]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['B']);
        assert.strictEqual(flatChanges(events).length, 0);
    });

    test('full (unscoped) refresh still replaces the entire collection', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('A', venvARoot), makeEnv('B', venvBRoot)]);

        const envX = makeEnv('X', path.join(ROOT, 'x', '.venv'));
        const envY = makeEnv('Y', path.join(ROOT, 'y', '.venv'));
        findVirtualEnvironmentsStub.resolves([envX, envY]);

        const events = captureEvents(manager);
        await manager.refresh(undefined);

        assert.deepStrictEqual(ids((manager as any).collection), ['X', 'Y'].sort());

        const changes = flatChanges(events);
        const removed = changes.filter((c) => c.kind === EnvironmentChangeKind.remove).map((c) => c.environment.envId.id);
        const added = changes.filter((c) => c.kind === EnvironmentChangeKind.add).map((c) => c.environment.envId.id);
        assert.deepStrictEqual(removed.sort(), ['A', 'B']);
        assert.deepStrictEqual(added.sort(), ['X', 'Y']);
    });

    test('passes the scope through to discovery as a single-element uri array', async () => {
        const manager = createManager();
        seed(manager, []);
        findVirtualEnvironmentsStub.resolves([]);

        const scope = Uri.file(folderA);
        await manager.refresh(scope);

        const uris = findVirtualEnvironmentsStub.firstCall.args[5] as Uri[] | undefined;
        assert.ok(Array.isArray(uris) && uris.length === 1);
        assert.strictEqual(uris[0].fsPath, scope.fsPath);
    });

    test('resolves a file scope to its containing directory for the merge', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        const fileScope = Uri.file(path.join(folderA, 'main.py'));
        findParentIfFileStub.callsFake(async () => folderA);
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        await manager.refresh(fileScope);

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'B']);
    });

    test('falls back to the raw scope when the scope path cannot be inspected', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        findParentIfFileStub.rejects(new Error('ENOENT: no such file or directory'));
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'B']);
    });
});
