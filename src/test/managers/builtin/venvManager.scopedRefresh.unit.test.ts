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
import { normalizePath } from '../../../common/utils/pathUtils';
import * as windowApis from '../../../common/window.apis';
import * as envCommands from '../../../features/envCommands';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

// Root used to build synthetic, absolute, platform-appropriate workspace paths.
// No files are created on disk: discovery is stubbed and the workspace-project loop
// in loadEnvMap is skipped because getPythonProjects() returns [].
const ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-scoped-refresh')).fsPath;
// A global location deliberately OUTSIDE of ROOT to model ~/.virtualenvs / venvFolders.
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

function normalizedPaths(collection: PythonEnvironment[]): Set<string> {
    return new Set(collection.map((e) => normalizePath(e.environmentPath.fsPath)));
}

function ids(collection: PythonEnvironment[]): string[] {
    return collection.map((e) => e.envId.id).sort();
}

suite('VenvManager - scoped refresh preservation', () => {
    let findVirtualEnvironmentsStub: sinon.SinonStub;
    let findParentIfFileStub: sinon.SinonStub;

    // Paths for a multi-root workspace. `app` and `app-2` intentionally share a name
    // prefix to exercise sibling-prefix safety in the containment check.
    const folderA = path.join(ROOT, 'app');
    const folderB = path.join(ROOT, 'app-2');
    const venvARoot = path.join(folderA, '.venv');
    const venvBRoot = path.join(folderB, '.venv');
    const globalVenvRoot = path.join(GLOBAL_ROOT, 'shared-env');

    function createManager(baseEnvironments: PythonEnvironment[] = []): VenvManager {
        const api = {
            getEnvironments: sinon.stub().resolves([]),
            getPythonProject: sinon.stub().returns(undefined),
            getPythonProjects: sinon.stub().returns([]),
            refreshEnvironments: sinon.stub().resolves(undefined),
        } as any as PythonEnvironmentApi;
        const baseManager = {
            getEnvironments: sinon.stub().resolves(baseEnvironments),
        } as any as EnvironmentManager;
        const manager = new VenvManager({} as NativePythonFinder, api, baseManager, {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
        } as any);
        // Mark as initialized so getEnvironments() does not trigger a real discovery.
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
        // Avoid touching persistent state during loadEnvMap()/loadGlobalEnv().
        sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        // Scope normalization stats the path; by default resolve a scope to itself (a directory).
        // No files are created on disk, so the real fs.stat would otherwise reject.
        findParentIfFileStub = sinon.stub(envCommands, 'findParentIfFile').callsFake(async (p: string) => p);
        // Run the progress task synchronously; the real vscode.window mock never invokes it.
        sinon
            .stub(windowApis, 'withProgress')
            .callsFake((_options: any, task: any) =>
                task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
            );
    });

    teardown(() => {
        sinon.restore();
    });

    test('retains sibling and global environments and keeps discovered metadata authoritative', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A-old', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envAOld, envB, envGlobal]);

        // Scoped discovery of folder A returns a fresh object for the same path (in-place update).
        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        // Sibling (B) and global (G) are retained; A is represented by the fresh discovered object.
        assert.deepStrictEqual(ids(collection), ['A-new', 'B', 'G']);
        assert.ok(
            collection.includes(envB) && collection.includes(envGlobal),
            'Sibling and global environment objects must be retained unchanged',
        );
        assert.ok(collection.includes(envANew), 'Discovered environment must replace the stale in-scope entry');
        assert.ok(!collection.includes(envAOld), 'Stale in-scope object must not be reused (metadata is authoritative)');

        // No add/remove events for the sibling or global, and none for A (same path => in-place update).
        const changes = flatChanges(events);
        const touchedIds = changes.map((c) => c.environment.envId.id);
        assert.ok(!touchedIds.includes('B'), 'No event should reference the sibling environment');
        assert.ok(!touchedIds.includes('G'), 'No event should reference the global environment');
        assert.strictEqual(changes.length, 0, 'An in-place update with the same path must not emit add/remove events');
    });

    test('removes only stale environments inside the target scope', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envA, envB, envGlobal]);

        // Folder A's environment was deleted -> scoped discovery finds nothing in A.
        findVirtualEnvironmentsStub.resolves([]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['B', 'G'], 'Only the stale in-scope environment should be removed');

        const changes = flatChanges(events);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(changes[0].environment.envId.id, 'A');
    });

    test('adds newly discovered environments in the target scope', async () => {
        const manager = createManager();
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envB]);

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);

        const changes = flatChanges(events);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].kind, EnvironmentChangeKind.add);
        assert.strictEqual(changes[0].environment.envId.id, 'A-new');
    });

    test('deduplicates overlapping discovery results by normalized path', async () => {
        const manager = createManager();
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envB]);

        // The native finder can return the same in-scope path twice when the scope overlaps a
        // configured venvFolder; the collection must contain a single entry for that path.
        const first = makeEnv('A-1', venvARoot);
        const duplicate = makeEnv('A-2', venvARoot);
        findVirtualEnvironmentsStub.resolves([first, duplicate]);

        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.strictEqual(normalizedPaths(collection).size, collection.length, 'Collection must not contain duplicates');
        const aEntries = collection.filter(
            (e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot)),
        );
        assert.strictEqual(aEntries.length, 1, 'Overlapping discovery results must be deduplicated by path');
    });

    test('retains configured global venvFolders returned by scoped discovery without duplication', async () => {
        const manager = createManager();
        // A global venvFolders environment already known to the manager (outside the target scope).
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envGlobal]);

        // Scoped discovery also searches configured venvFolders, so it returns a *fresh* copy of the
        // global environment (out of scope) alongside the new in-scope one. The out-of-scope result
        // must be ignored so the existing global object is retained and not duplicated/churned.
        const envANew = makeEnv('A-new', venvARoot);
        const envGlobalFresh = makeEnv('G-fresh', globalVenvRoot);
        findVirtualEnvironmentsStub.resolves([envANew, envGlobalFresh]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'G'], 'The original global object must be retained, not the fresh copy');
        assert.ok(collection.includes(envGlobal));
        assert.ok(!collection.some((e) => e.envId.id === 'G-fresh'), 'Out-of-scope discovery duplicate must be ignored');

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [{ id: 'A-new', kind: EnvironmentChangeKind.add }],
            'Only the genuinely new in-scope environment should be announced',
        );
    });

    test('treats sibling directories sharing a name prefix as outside the scope (app vs app-2)', async () => {
        const manager = createManager();
        const envB = makeEnv('B', venvBRoot); // lives under `.../app-2`
        seed(manager, [envB]);

        // Refresh `.../app`. Discovery finds nothing there. `.../app-2` must NOT be treated as inside.
        findVirtualEnvironmentsStub.resolves([]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['B'], 'Sibling with shared prefix must be retained');
        assert.strictEqual(flatChanges(events).length, 0, 'No events should fire for the untouched sibling');
    });

    test('full (unscoped) refresh still replaces the entire collection', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envA, envB]);

        const envX = makeEnv('X', path.join(ROOT, 'x', '.venv'));
        const envY = makeEnv('Y', path.join(ROOT, 'y', '.venv'));
        findVirtualEnvironmentsStub.resolves([envX, envY]);

        const events = captureEvents(manager);
        await manager.refresh(undefined);

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['X', 'Y'].sort());

        // Existing behavior: remove every previous environment and add every discovered one.
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

    test('emits remove+add when in-scope metadata changes at the same path', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A-old', venvARoot, '3.11.0');
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envAOld, envB]);

        // Same path, but the discovered environment reports a different (upgraded) version.
        const envANew = makeEnv('A-new', venvARoot, '3.12.5');
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);
        assert.ok(collection.includes(envANew), 'Fresh metadata must replace the stale in-scope entry');

        // A real metadata change is announced as remove(old)+add(new); the sibling is untouched.
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A-old', kind: EnvironmentChangeKind.remove },
                { id: 'A-new', kind: EnvironmentChangeKind.add },
            ],
            'In-place metadata update must fire a paired remove/add only for the changed environment',
        );
    });

    test('resolves a file scope to its containing directory for discovery and merge', async () => {
        const manager = createManager();
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envB]);

        // A file Uri whose parent directory is folderA (per RefreshEnvironmentsScope, a file is allowed).
        const fileScope = Uri.file(path.join(folderA, 'main.py'));
        findParentIfFileStub.callsFake(async () => folderA);

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        await manager.refresh(fileScope);

        // Discovery received the parent directory, not the file itself.
        const uris = findVirtualEnvironmentsStub.firstCall.args[5] as Uri[] | undefined;
        assert.ok(Array.isArray(uris) && uris.length === 1);
        assert.strictEqual(uris[0].fsPath, folderA, 'Discovery must run against the containing directory');

        // The merge used the directory: the in-scope env is added and the sibling retained.
        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);
    });

    test('falls back to the raw scope when the scope path cannot be inspected', async () => {
        const manager = createManager();
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envB]);

        // findParentIfFile rejects (e.g. the scope path no longer exists on disk).
        findParentIfFileStub.rejects(new Error('ENOENT: no such file or directory'));

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const scope = Uri.file(folderA);
        await manager.refresh(scope);

        // Discovery and the merge still run against the raw scope directory (best-effort behavior).
        const uris = findVirtualEnvironmentsStub.firstCall.args[5] as Uri[] | undefined;
        assert.ok(Array.isArray(uris) && uris.length === 1);
        assert.strictEqual(uris[0].fsPath, scope.fsPath);

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);
    });

    test('does not fire a phantom removal when loadEnvMap resurrects a still-resolvable env', async () => {
        const projectUri = Uri.file(folderA);
        const manager = createManager();
        (manager as any).api.getPythonProjects = sinon.stub().returns([{ uri: projectUri, name: 'app' }]);

        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envA, envB]);

        // Discovery finds nothing in folder A (the env looks gone) ...
        findVirtualEnvironmentsStub.resolves([]);
        // ... but a persisted workspace setting still points at a path that resolves, so loadEnvMap
        // re-adds it to the collection.
        sinon.stub(venvUtils, 'getVenvForWorkspace').resolves(venvPython(venvARoot));
        sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(makeEnv('A-resolved', venvARoot));

        const events = captureEvents(manager);
        await manager.refresh(projectUri);

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(
            collection.some((e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot))),
            'A resolvable environment must remain in the collection',
        );

        // Events reflect the final collection state: the resurrected env is present with identical
        // metadata, so no removal (and no add) is fired.
        const changes = flatChanges(events);
        assert.strictEqual(
            changes.filter((c) => c.kind === EnvironmentChangeKind.remove).length,
            0,
            'A resolvable env must not be reported as removed',
        );
    });

    test('retains a nested project environment when refreshing the parent folder', async () => {
        const nestedRoot = path.join(folderA, 'nested');
        const nestedVenv = path.join(nestedRoot, '.venv');

        const manager = createManager();
        // folder A owns its own env; `nestedRoot` is a *separate* project nested under folder A.
        (manager as any).api.getPythonProject = sinon.stub().callsFake((uri: Uri) => {
            const p = normalizePath(uri.fsPath);
            if (p === normalizePath(venvPython(nestedVenv))) {
                return { uri: Uri.file(nestedRoot), name: 'nested' };
            }
            if (p === normalizePath(venvPython(venvARoot))) {
                return { uri: Uri.file(folderA), name: 'app' };
            }
            return undefined;
        });

        const envA = makeEnv('A', venvARoot);
        const envNested = makeEnv('Nested', nestedVenv);
        seed(manager, [envA, envNested]);

        // Refreshing folder A rediscovers only folder A's own env; the nested project's env is not
        // surfaced by the scoped search. Path containment alone would wrongly drop it.
        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'Nested']);
        assert.ok(collection.includes(envNested), 'Nested project environment must be retained untouched');

        // The nested env is neither removed nor churned.
        const changes = flatChanges(events);
        assert.ok(
            !changes.some((c) => c.environment.envId.id === 'Nested'),
            'No event may reference the nested project environment',
        );
    });
});
