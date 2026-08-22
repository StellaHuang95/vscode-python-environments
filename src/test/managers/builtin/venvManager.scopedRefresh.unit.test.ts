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
    PythonProject,
} from '../../../api';
import { VENV_MANAGER_ID } from '../../../common/constants';
import { createDeferred } from '../../../common/utils/deferred';
import { isPathInside, normalizePath } from '../../../common/utils/pathUtils';
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
    let getVenvFoldersSettingStub: sinon.SinonStub;
    let getVenvForWorkspaceStub: sinon.SinonStub;
    let getVenvForGlobalStub: sinon.SinonStub;
    let resolveEnvStub: sinon.SinonStub;

    // Paths for a multi-root workspace. `app` and `app-2` intentionally share a name
    // prefix to exercise sibling-prefix safety in the containment check.
    const folderA = path.join(ROOT, 'app');
    const folderB = path.join(ROOT, 'app-2');
    const venvARoot = path.join(folderA, '.venv');
    const venvBRoot = path.join(folderB, '.venv');
    const globalVenvRoot = path.join(GLOBAL_ROOT, 'shared-env');

    // A project object for `folderA`, reused by tests that need an owning project.
    const projectA: PythonProject = { uri: Uri.file(folderA), name: 'app' } as PythonProject;
    const projectB: PythonProject = { uri: Uri.file(folderB), name: 'app-2' } as PythonProject;

    // Yields to the macrotask queue so that already-scheduled microtasks (queued refreshes) run.
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

    /**
     * Configures `api.getPythonProject` so that any Uri inside one of the given project roots
     * resolves to that project (deepest root wins, mirroring the real projectManager). Used to model
     * a multi-root workspace in which environments and scopes are owned by specific projects.
     */
    function ownProjects(manager: VenvManager, projects: PythonProject[]): void {
        const sorted = [...projects].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        (manager as any).api.getPythonProject = sinon.stub().callsFake((uri: Uri) => {
            return sorted.find((p) => isPathInside(p.uri.fsPath, uri.fsPath));
        });
    }

    function seed(manager: VenvManager, envs: PythonEnvironment[]): void {
        (manager as any).collection = envs;
    }

    function mapEntry(manager: VenvManager, fsPath: string): PythonEnvironment | undefined {
        return ((manager as any).fsPathToEnv as Map<string, PythonEnvironment>).get(normalizePath(fsPath));
    }

    function setMapEntry(manager: VenvManager, fsPath: string, env: PythonEnvironment): void {
        ((manager as any).fsPathToEnv as Map<string, PythonEnvironment>).set(normalizePath(fsPath), env);
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
        // Avoid touching persistent state during global/workspace mapping.
        getVenvForGlobalStub = sinon.stub(venvUtils, 'getVenvForGlobal').resolves(undefined);
        getVenvForWorkspaceStub = sinon.stub(venvUtils, 'getVenvForWorkspace').resolves(undefined);
        resolveEnvStub = sinon.stub(venvUtils, 'resolveVenvPythonEnvironmentPath').resolves(undefined);
        // By default no global venvFolders are configured.
        getVenvFoldersSettingStub = sinon.stub(venvUtils, 'getVenvFoldersSetting').returns([]);
        // Scope normalization stats the path; by default resolve a scope to itself (a directory).
        // No files are created on disk, so the real fs.stat would otherwise reject.
        findParentIfFileStub = sinon.stub(envCommands, 'findParentIfFile').callsFake(async (p: string) => p);
        // Run the progress task synchronously; the real vscode.window mock never invokes it.
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

    test('retains siblings and globals and rediscovers the in-scope env with a preserved id', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A-old', venvARoot, '3.11.0');
        const envB = makeEnv('B', venvBRoot);
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envAOld, envB, envGlobal]);

        // Scoped discovery of folder A returns a fresh object (new random id, upgraded metadata) for
        // the same path.
        const envANew = makeEnv('A-new', venvARoot, '3.12.5');
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        // Sibling (B) and global (G) are retained as the very same objects.
        assert.ok(
            collection.includes(envB) && collection.includes(envGlobal),
            'Sibling and global environment objects must be retained unchanged',
        );

        // A is represented by a fresh object that adopts the discovered metadata but keeps the prior
        // stable id (neither the stale object nor the discovered id is reused).
        const a = collection.find(
            (e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot)),
        )!;
        assert.strictEqual(a.envId.id, 'A-old', 'The stable envId must be preserved across rediscovery');
        assert.strictEqual(a.version, '3.12.5', 'Fresh discovered metadata must win');
        assert.notStrictEqual(a, envAOld, 'The stale object must not be reused');
        assert.notStrictEqual(a, envANew, 'The discovered id must not replace the preserved id');

        // Announced as remove(old)+add(new) carrying the preserved id; siblings/globals are untouched.
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A-old', kind: EnvironmentChangeKind.remove },
                { id: 'A-old', kind: EnvironmentChangeKind.add },
            ],
            'A rediscovered in-scope env is announced as remove(old)+add(new) with the preserved id',
        );
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

    test('always announces a rediscovered in-scope env as remove+add, even when metadata is unchanged', async () => {
        const manager = createManager();
        // Identical metadata on both sides: only the random discovery id differs.
        const envAOld = makeEnv('A-old', venvARoot, '3.12.0');
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envAOld, envB]);

        const envANew = makeEnv('A-new', venvARoot, '3.12.0');
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        const a = collection.find(
            (e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot)),
        )!;
        assert.strictEqual(a.envId.id, 'A-old', 'The stable id is preserved for the rediscovered env');
        assert.notStrictEqual(a, envAOld, 'A fresh object carries the authoritative metadata');

        // Because full semantic equality (execInfo/activation) cannot be proven cheaply, the refresh
        // is announced as a paired remove/add rather than silently swapping the object with no event.
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A-old', kind: EnvironmentChangeKind.remove },
                { id: 'A-old', kind: EnvironmentChangeKind.add },
            ],
            'A rediscovered in-scope env must fire remove+add (preserving id); the sibling is untouched',
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

    test('resolves the owning project persisted env and surfaces it as a scope-local addition', async () => {
        const manager = createManager();
        ownProjects(manager, [projectA, projectB]);

        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envA, envB]);

        // Discovery finds nothing in folder A (its env is not surfaced this pass) ...
        findVirtualEnvironmentsStub.resolves([]);
        // ... but a persisted workspace setting for folder A still points at a resolvable interpreter.
        getVenvForWorkspaceStub.withArgs(folderA).resolves(venvPython(venvARoot));
        const resolved = makeEnv('A-resolved', venvARoot);
        resolveEnvStub.resolves(resolved);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(collection.includes(resolved), 'The persisted env is resolved back into the collection');
        assert.ok(collection.includes(envB), 'The sibling B is retained untouched');

        // The scope-local reconciliation runs against only the owning project's map entry; the global
        // map is never rebuilt (loadEnvMap would call getVenvForGlobal).
        assert.ok(getVenvForGlobalStub.notCalled, 'Scoped refresh must not rebuild the global env map');

        // The persisted-map addition is surfaced (req 7); the stale discovery result is removed.
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A', kind: EnvironmentChangeKind.remove },
                { id: 'A-resolved', kind: EnvironmentChangeKind.add },
            ],
            'Discovery removal and the persisted-map addition are both surfaced for the target scope',
        );
    });

    test('resolves the effective project for a nested file scope without inspecting the filesystem', async () => {
        const manager = createManager();
        // folder A owns any Uri beneath it, including the nested source file used as the scope.
        ownProjects(manager, [projectA, projectB]);

        const nestedFile = Uri.file(path.join(folderA, 'src', 'main.py'));
        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        await manager.refresh(nestedFile);

        // Because a project owns the file, the scope resolves to the project root directly; the
        // directory-inspection fallback (findParentIfFile) is never consulted.
        assert.ok(findParentIfFileStub.notCalled, 'An owned scope must not fall back to findParentIfFile');

        // Discovery ran against the owning project root (folder A), not the nested file.
        const uris = findVirtualEnvironmentsStub.firstCall.args[5] as Uri[] | undefined;
        assert.ok(Array.isArray(uris) && uris.length === 1);
        assert.strictEqual(uris[0].fsPath, folderA, 'Discovery must run against the owning project root');

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(
            collection.some((e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot))),
            'The owning project env is discovered under the resolved project root',
        );
    });

    test('leaves sibling and global persisted map entries untouched during a scoped refresh', async () => {
        const manager = createManager();
        ownProjects(manager, [projectA, projectB]);

        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        const envGlobal = makeEnv('G', globalVenvRoot);
        seed(manager, [envA, envB, envGlobal]);
        // Pre-existing map entries for the sibling project and the global scope.
        setMapEntry(manager, folderB, envB);
        (manager as any).globalEnv = envGlobal;

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        await manager.refresh(Uri.file(folderA));

        // The sibling's and global's map/state entries are exactly as before the refresh.
        assert.strictEqual(mapEntry(manager, folderB), envB, 'The sibling map entry must be preserved');
        assert.strictEqual((manager as any).globalEnv, envGlobal, 'The global env must not be rebuilt');
        assert.ok(getVenvForGlobalStub.notCalled, 'Scoped refresh must not consult global mapping state');
    });

    test('re-points the cached default interpreter when it is rediscovered in the refreshed scope', async () => {
        const manager = createManager();
        ownProjects(manager, [projectA]);

        // The default (global) interpreter happens to be folder A's own venv.
        const envAOld = makeEnv('A', venvARoot, '3.11.0');
        seed(manager, [envAOld]);
        (manager as any).globalEnv = envAOld;

        // Refreshing folder A rediscovers that same interpreter with upgraded metadata.
        const envANew = makeEnv('A-new', venvARoot, '3.12.5');
        findVirtualEnvironmentsStub.resolves([envANew]);

        await manager.refresh(Uri.file(folderA));

        // The cached default (what get(undefined) returns) now carries the fresh metadata but keeps
        // the preserved id, and is the very object that lives in the rebuilt collection.
        const collection: PythonEnvironment[] = (manager as any).collection;
        const rebuiltA = collection.find(
            (e) => normalizePath(e.environmentPath.fsPath) === normalizePath(venvPython(venvARoot)),
        )!;
        const cachedGlobal: PythonEnvironment | undefined = (manager as any).globalEnv;
        assert.strictEqual(cachedGlobal, rebuiltA, 'The cached default must point at the rebuilt in-scope object');
        assert.strictEqual(cachedGlobal!.envId.id, 'A', 'The preserved id is retained');
        assert.strictEqual(cachedGlobal!.version, '3.12.5', 'The cached default must not keep stale metadata');
        assert.ok(getVenvForGlobalStub.notCalled, 'Re-pointing must not rebuild global discovery');
    });

    test('serializes concurrent A/B scoped refreshes so they cannot interleave', async () => {
        const manager = createManager();
        ownProjects(manager, [projectA, projectB]);
        seed(manager, []);

        // First refresh (A) blocks inside discovery until we release it; the second (B) must wait.
        const gateA = createDeferred<PythonEnvironment[]>();
        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        findVirtualEnvironmentsStub.onCall(0).returns(gateA.promise);
        findVirtualEnvironmentsStub.onCall(1).resolves([envB]);

        const pA = manager.refresh(Uri.file(folderA));
        const pB = manager.refresh(Uri.file(folderB));
        await tick();

        // B's discovery has not started while A is still in-flight (transactions are serialized).
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 1, 'The second refresh must wait for the first');

        gateA.resolve([envA]);
        await pA;
        await pB;

        // Both transactions committed against a consistent collection: A then B, neither clobbering the
        // other. Interleaving would have dropped one of them.
        assert.strictEqual(findVirtualEnvironmentsStub.callCount, 2, 'The second refresh runs after the first commits');
        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A', 'B'], 'Both scoped results survive serialized refreshes');
    });

    test('keeps the refresh chain usable after a rejected transaction and preserves the caller error', async () => {
        const manager = createManager();
        ownProjects(manager, [projectA, projectB]);
        seed(manager, []);

        const boom = new Error('discovery exploded');
        findVirtualEnvironmentsStub.onCall(0).rejects(boom);
        const envB = makeEnv('B', venvBRoot);
        findVirtualEnvironmentsStub.onCall(1).resolves([envB]);

        // The caller sees the real rejection ...
        await assert.rejects(manager.refresh(Uri.file(folderA)), /discovery exploded/);

        // ... and a subsequent refresh still runs through the (still-usable) chain.
        await manager.refresh(Uri.file(folderB));
        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['B'], 'The chain remains usable after a rejected refresh');
    });

    test('retains a configured global venvFolders env nested under the refreshed workspace', async () => {
        const manager = createManager();
        // The workspace root is folder A; a configured global venvFolders root lives *inside* it.
        ownProjects(manager, [projectA]);
        const globalRootInsideWorkspace = path.join(folderA, '.venvs');
        const globalEnvRoot = path.join(globalRootInsideWorkspace, 'shared');
        getVenvFoldersSettingStub.returns([globalRootInsideWorkspace]);

        const envA = makeEnv('A', venvARoot);
        const envConfiguredGlobal = makeEnv('CG', globalEnvRoot);
        seed(manager, [envA, envConfiguredGlobal]);

        // Scoped discovery of folder A surfaces its own env; the configured-global env is not part of
        // this refresh result. Path containment alone would wrongly treat it as in-scope and remove it.
        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(
            collection.includes(envConfiguredGlobal),
            'An env under a configured global venvFolders root must not be authoritatively removed',
        );
        const changes = flatChanges(events);
        assert.ok(
            !changes.some((c) => c.environment.envId.id === 'CG'),
            'No removal event may be fired for a configured-global env nested under the workspace',
        );
    });

    test('retains a configured global env under a filesystem-root scope (protected only by venvFolders)', async () => {
        const manager = createManager();
        // The scope is the actual filesystem root, so *every* path is nominally inside it and path
        // containment alone cannot exclude the global env — only the configured-venvFolders check can.
        const fsRoot = path.parse(ROOT).root;
        const rootScope = Uri.file(fsRoot);
        const rootProject: PythonProject = { uri: rootScope, name: 'fsroot' } as PythonProject;
        ownProjects(manager, [rootProject]);

        const globalRoot = path.join(fsRoot, 'global-venvs');
        const globalEnvRoot = path.join(globalRoot, 'shared');
        getVenvFoldersSettingStub.returns([globalRoot]);

        const envA = makeEnv('A', venvARoot); // under fsRoot, not under the configured global root
        const envGlobal = makeEnv('G', globalEnvRoot); // under fsRoot AND under the configured global root
        seed(manager, [envA, envGlobal]);

        const envANew = makeEnv('A-new', venvARoot);
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(rootScope);

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(
            collection.includes(envGlobal),
            'A configured-global env must survive a filesystem-root scope via the venvFolders exclusion',
        );
        const changes = flatChanges(events);
        assert.ok(
            !changes.some((c) => c.environment.envId.id === 'G'),
            'No removal event may be fired for the configured-global env under a root scope',
        );
    });

    test('retains a configured global venvFolders env whose root is written with a ~ (tilde) prefix', async () => {
        const manager = createManager();
        // Users commonly configure venvFolders as `~/.virtualenvs`; the stored setting keeps the tilde,
        // and (like discovery) it is not pre-expanded, so the refresh must expand it before comparing.
        const home = os.homedir();
        const workspaceRoot = home; // model a workspace rooted at the home directory
        const wsProject: PythonProject = { uri: Uri.file(workspaceRoot), name: 'home-ws' } as PythonProject;
        ownProjects(manager, [wsProject]);

        getVenvFoldersSettingStub.returns(['~/.tilde-venvs']);
        const expandedGlobalRoot = path.join(home, '.tilde-venvs');
        const wsVenvRoot = path.join(workspaceRoot, 'app', '.venv');
        const tildeGlobalEnvRoot = path.join(expandedGlobalRoot, 'env');

        const envWs = makeEnv('WS', wsVenvRoot);
        const envTildeGlobal = makeEnv('TG', tildeGlobalEnvRoot);
        seed(manager, [envWs, envTildeGlobal]);

        const envWsNew = makeEnv('WS-new', wsVenvRoot);
        findVirtualEnvironmentsStub.resolves([envWsNew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(workspaceRoot));

        // The tilde root must be expanded before containment; otherwise the global env (nested under
        // the workspace) is wrongly treated as in-scope and removed.
        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.ok(
            collection.includes(envTildeGlobal),
            'A ~-configured global env nested under the workspace must be retained',
        );
        const changes = flatChanges(events);
        assert.ok(
            !changes.some((c) => c.environment.envId.id === 'TG'),
            'No removal event may be fired for the ~-configured global env',
        );
    });

    test('retains a nested project environment when refreshing the parent folder', async () => {
        const nestedRoot = path.join(folderA, 'nested');
        const nestedVenv = path.join(nestedRoot, '.venv');
        const nestedProject: PythonProject = { uri: Uri.file(nestedRoot), name: 'nested' } as PythonProject;

        const manager = createManager();
        // folder A owns its own env; `nestedRoot` is a *separate*, deeper project nested under folder A.
        ownProjects(manager, [projectA, nestedProject]);

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
        // A keeps its preserved id; the nested project env is retained as the very same object.
        assert.deepStrictEqual(ids(collection), ['A', 'Nested']);
        assert.ok(collection.includes(envNested), 'Nested project environment must be retained untouched');

        // The nested env is neither removed nor churned.
        const changes = flatChanges(events);
        assert.ok(
            !changes.some((c) => c.environment.envId.id === 'Nested'),
            'No event may reference the nested project environment',
        );
    });
});
