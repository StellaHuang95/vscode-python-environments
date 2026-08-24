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
import { createDeferred } from '../../../common/utils/deferred';
import * as windowApis from '../../../common/window.apis';
import * as envCommands from '../../../features/envCommands';
import { VenvManager } from '../../../managers/builtin/venvManager';
import * as venvUtils from '../../../managers/builtin/venvUtils';
import { NativePythonFinder } from '../../../managers/common/nativePythonFinder';
import { createMockPythonEnvironment } from '../../mocks/pythonEnvironment';

const ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-scoped-refresh')).fsPath;
const GLOBAL_ROOT = Uri.file(path.join(os.tmpdir(), 'vscode-python-envs-tests', 'venv-scoped-global')).fsPath;

suite('VenvManager - scoped refresh preservation', () => {
    let findVirtualEnvironmentsStub: sinon.SinonStub;
    let findParentIfFileStub: sinon.SinonStub;

    const folderA = path.join(ROOT, 'app');
    const folderB = path.join(ROOT, 'app-2');
    const venvARoot = path.join(folderA, '.venv');
    const venvBRoot = path.join(folderB, '.venv');
    const globalVenvRoot = path.join(GLOBAL_ROOT, 'shared-env');

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
        assert.deepStrictEqual(ids(collection), ['A-new', 'B', 'G']);
        assert.strictEqual(collection.length, 3);
        assert.ok(collection.includes(envB) && collection.includes(envGlobal) && collection.includes(envANew));
        assert.ok(!collection.includes(envAOld));

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A-old', kind: EnvironmentChangeKind.remove },
                { id: 'A-new', kind: EnvironmentChangeKind.add },
            ],
        );
    });

    test('replaces a same-path environment sharing its id when the discovered object differs', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A', venvARoot, '3.11.0');
        seed(manager, [envAOld]);

        const envANew = makeEnv('A', venvARoot, '3.12.5');
        findVirtualEnvironmentsStub.resolves([envANew]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.strictEqual(collection.length, 1);
        assert.strictEqual(collection[0], envANew);
        assert.ok(!collection.includes(envAOld));

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [
                { id: 'A', kind: EnvironmentChangeKind.remove },
                { id: 'A', kind: EnvironmentChangeKind.add },
            ],
        );
        assert.strictEqual(changes[0].environment, envAOld);
        assert.strictEqual(changes[1].environment, envANew);
    });

    test('emits no event when the exact same environment object is rediscovered in scope', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);

        findVirtualEnvironmentsStub.resolves([envA]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.strictEqual(collection.length, 1);
        assert.strictEqual(collection[0], envA);
        assert.deepStrictEqual(events, []);
    });

    test('emits a remove for every stale in-scope duplicate that shares a normalized path', async () => {
        const manager = createManager();
        const dup1 = makeEnv('A-dup-1', venvARoot);
        const dup2 = makeEnv('A-dup-2', venvARoot);
        seed(manager, [dup1, dup2, makeEnv('B', venvBRoot)]);

        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);
        assert.ok(!collection.includes(dup1) && !collection.includes(dup2));

        const changes = flatChanges(events).map((c) => ({ id: c.environment.envId.id, kind: c.kind }));
        const removed = changes
            .filter((c) => c.kind === EnvironmentChangeKind.remove)
            .map((c) => c.id)
            .sort();
        const added = changes.filter((c) => c.kind === EnvironmentChangeKind.add).map((c) => c.id);
        assert.deepStrictEqual(removed, ['A-dup-1', 'A-dup-2']);
        assert.deepStrictEqual(added, ['A-new']);
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

    test('does not admit newly discovered out-of-scope global environments', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot), makeEnv('G-new', globalVenvRoot)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        const collection: PythonEnvironment[] = (manager as any).collection;
        assert.deepStrictEqual(ids(collection), ['A-new', 'B']);
        assert.ok(!collection.some((e) => e.envId.id === 'G-new'));

        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [{ id: 'A-new', kind: EnvironmentChangeKind.add }],
        );
    });

    test('deduplicates discovered environments that share a normalized path', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        findVirtualEnvironmentsStub.resolves([makeEnv('A-dup-1', venvARoot), makeEnv('A-dup-2', venvARoot)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-dup-1', 'B']);
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [{ id: 'A-dup-1', kind: EnvironmentChangeKind.add }],
        );
    });

    test('treats sibling directories sharing a name prefix as outside the scope (app vs app-2)', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);
        findVirtualEnvironmentsStub.resolves([]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['B']);
        assert.deepStrictEqual(events, []);
    });

    test('scopes a nested directory refresh to that directory, not the whole owning project', async () => {
        const manager = createManager();
        const pkgVenv = path.join(folderA, 'pkg', '.venv');
        const otherVenv = path.join(folderA, 'other', '.venv');
        seed(manager, [makeEnv('PKG-old', pkgVenv), makeEnv('OTHER', otherVenv)]);

        ((manager as any).api.getPythonProject as sinon.SinonStub).returns({ uri: Uri.file(folderA) });
        findVirtualEnvironmentsStub.resolves([makeEnv('PKG-new', pkgVenv)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(path.join(folderA, 'pkg')));

        assert.deepStrictEqual(ids((manager as any).collection), ['OTHER', 'PKG-new']);
        const changes = flatChanges(events)
            .map((c) => ({ id: c.environment.envId.id, kind: c.kind }))
            .sort((a, b) => a.id.localeCompare(b.id));
        assert.deepStrictEqual(changes, [
            { id: 'PKG-new', kind: EnvironmentChangeKind.add },
            { id: 'PKG-old', kind: EnvironmentChangeKind.remove },
        ]);
    });

    test('resolves a file scope to its containing directory when no project owns it', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        const fileScope = Uri.file(path.join(folderA, 'main.py'));
        findParentIfFileStub.callsFake(async () => folderA);
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        await manager.refresh(fileScope);

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'B']);
    });

    test('skips scoped mutation for a deleted file scope owned by a project', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('A-old', venvARoot), makeEnv('B', venvBRoot)]);

        const deletedScope = Uri.file(path.join(folderA, 'main.py'));
        ((manager as any).api.getPythonProject as sinon.SinonStub).returns({ uri: Uri.file(folderA) });
        findParentIfFileStub.callsFake(async (p: string) => {
            if (p === deletedScope.fsPath) {
                throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
            }
            return p;
        });
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        const events = captureEvents(manager);
        await manager.refresh(deletedScope);

        assert.deepStrictEqual(ids((manager as any).collection), ['A-old', 'B']);
        assert.deepStrictEqual(events, []);
    });

    test('skips scoped mutation for a missing nested directory scope owned by a project', async () => {
        const manager = createManager();
        const pkgVenv = path.join(folderA, 'pkg', '.venv');
        const otherVenv = path.join(folderA, 'other', '.venv');
        seed(manager, [makeEnv('PKG', pkgVenv), makeEnv('OTHER', otherVenv)]);

        const missingNested = Uri.file(path.join(folderA, 'pkg'));
        ((manager as any).api.getPythonProject as sinon.SinonStub).returns({ uri: Uri.file(folderA) });
        findParentIfFileStub.callsFake(async (p: string) => {
            if (p === missingNested.fsPath) {
                throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
            }
            return p;
        });
        findVirtualEnvironmentsStub.resolves([makeEnv('PKG-new', pkgVenv)]);

        const events = captureEvents(manager);
        await manager.refresh(missingNested);

        assert.ok(findVirtualEnvironmentsStub.notCalled);
        assert.deepStrictEqual(ids((manager as any).collection), ['OTHER', 'PKG']);
        assert.deepStrictEqual(events, []);
    });

    test('skips scoped mutation without widening when an uninspectable directory scope equals its owning project uri', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('A', venvARoot), makeEnv('B', venvBRoot)]);

        ((manager as any).api.getPythonProject as sinon.SinonStub).returns({ uri: Uri.file(folderA) });
        findParentIfFileStub.rejects(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A', 'B']);
        assert.deepStrictEqual(events, []);
    });

    test('skips scoped mutation for an uninspectable file scope that no project owns', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('A-old', venvARoot), makeEnv('B', venvBRoot)]);

        findParentIfFileStub.rejects(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(path.join(folderA, 'deleted.py')));

        assert.ok(findVirtualEnvironmentsStub.notCalled);
        assert.deepStrictEqual(ids((manager as any).collection), ['A-old', 'B']);
        assert.deepStrictEqual(events, []);
    });

    test('rejects and surfaces the error without discovery when a scope inspection fails with EACCES', async () => {
        const manager = createManager();
        const pkgVenv = path.join(folderA, 'pkg', '.venv');
        const otherVenv = path.join(folderA, 'other', '.venv');
        seed(manager, [makeEnv('PKG', pkgVenv), makeEnv('OTHER', otherVenv)]);

        const nestedScope = Uri.file(path.join(folderA, 'pkg'));
        ((manager as any).api.getPythonProject as sinon.SinonStub).returns({ uri: Uri.file(folderA) });
        let call = 0;
        findParentIfFileStub.callsFake(async (p: string) => {
            call += 1;
            if (call === 1) {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }
            return p;
        });
        findVirtualEnvironmentsStub.resolves([makeEnv('PKG-new', pkgVenv)]);

        const events = captureEvents(manager);
        await assert.rejects(manager.refresh(nestedScope), /EACCES/);

        assert.ok(findVirtualEnvironmentsStub.notCalled);
        assert.deepStrictEqual(ids((manager as any).collection), ['OTHER', 'PKG']);
        assert.deepStrictEqual(events, []);

        await manager.refresh(nestedScope);
        assert.ok(findVirtualEnvironmentsStub.called);
        assert.deepStrictEqual(ids((manager as any).collection), ['OTHER', 'PKG-new']);
    });

    test('does not append an out-of-scope environment while loading the project map', async () => {
        const manager = createManager();
        seed(manager, []);

        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);
        ((manager as any).api.getPythonProjects as sinon.SinonStub).returns([{ uri: Uri.file(folderB) }]);
        (venvUtils.getVenvForWorkspace as sinon.SinonStub).resolves(venvPython(venvBRoot));
        (venvUtils.resolveVenvPythonEnvironmentPath as sinon.SinonStub).resolves(makeEnv('B-PERSISTED', venvBRoot));

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A-new', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('does not append a persisted global environment while loading the project map', async () => {
        const manager = createManager();
        seed(manager, []);

        findVirtualEnvironmentsStub.resolves([makeEnv('A-new', venvARoot)]);
        (venvUtils.getVenvForGlobal as sinon.SinonStub).resolves(venvPython(globalVenvRoot));
        (venvUtils.resolveVenvPythonEnvironmentPath as sinon.SinonStub).resolves(makeEnv('G-PERSISTED', globalVenvRoot));

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A-new', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('a scoped refresh announces an in-scope environment appended while loading the project map', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('B', venvBRoot)]);

        findVirtualEnvironmentsStub.resolves([]);
        ((manager as any).api.getPythonProjects as sinon.SinonStub).returns([{ uri: Uri.file(folderA) }]);
        (venvUtils.getVenvForWorkspace as sinon.SinonStub).resolves(venvPython(venvARoot));
        (venvUtils.resolveVenvPythonEnvironmentPath as sinon.SinonStub).resolves(makeEnv('PERSISTED', venvARoot));

        const events = captureEvents(manager);
        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['B', 'PERSISTED']);
        const changes = flatChanges(events);
        assert.deepStrictEqual(
            changes.map((c) => ({ id: c.environment.envId.id, kind: c.kind })),
            [{ id: 'PERSISTED', kind: EnvironmentChangeKind.add }],
        );
    });

    test('a full refresh in progress does not announce results discovered by a concurrent scoped refresh', async () => {
        const manager = createManager();
        seed(manager, []);

        const xRoot = path.join(ROOT, 'x', '.venv');
        const yRoot = path.join(ROOT, 'y', '.venv');
        findVirtualEnvironmentsStub.callsFake(async (...args: any[]) => {
            const uris = args[5] as Uri[] | undefined;
            return uris ? [makeEnv('A-new', venvARoot)] : [makeEnv('X', xRoot), makeEnv('Y', yRoot)];
        });

        const fullInLoadEnvMap = createDeferred<void>();
        const releaseFull = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                fullInLoadEnvMap.resolve();
                await releaseFull.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pFull = manager.refresh(undefined);
        await fullInLoadEnvMap.promise;
        const pScoped = manager.refresh(Uri.file(folderA));
        await new Promise((resolve) => setImmediate(resolve));
        releaseFull.resolve();
        await Promise.all([pFull, pScoped]);

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'X', 'Y']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [
                    { id: 'X', kind: EnvironmentChangeKind.add },
                    { id: 'Y', kind: EnvironmentChangeKind.add },
                ],
                [{ id: 'A-new', kind: EnvironmentChangeKind.add }],
            ],
        );
    });

    test('applies overlapping full refreshes in invocation order even when the first discovery is delayed', async () => {
        const manager = createManager();
        seed(manager, []);

        const gateFirst = createDeferred<void>();
        let call = 0;
        findVirtualEnvironmentsStub.callsFake(async () => {
            call += 1;
            if (call === 1) {
                await gateFirst.promise;
                return [makeEnv('FIRST', venvARoot)];
            }
            return [makeEnv('SECOND', venvBRoot)];
        });

        const events = captureEvents(manager);
        const pFirst = manager.refresh(undefined);
        const pSecond = manager.refresh(undefined);
        gateFirst.resolve();
        await Promise.all([pFirst, pSecond]);

        assert.deepStrictEqual(ids((manager as any).collection), ['SECOND']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [{ id: 'FIRST', kind: EnvironmentChangeKind.add }],
                [
                    { id: 'FIRST', kind: EnvironmentChangeKind.remove },
                    { id: 'SECOND', kind: EnvironmentChangeKind.add },
                ],
            ],
        );
    });

    test('keeps the refresh chain usable after a discovery failure', async () => {
        const manager = createManager();
        seed(manager, []);

        let call = 0;
        findVirtualEnvironmentsStub.callsFake(async () => {
            call += 1;
            if (call === 1) {
                throw new Error('discovery failed');
            }
            return [makeEnv('RECOVERED', venvARoot)];
        });

        const events = captureEvents(manager);
        await assert.rejects(manager.refresh(undefined), /discovery failed/);
        await manager.refresh(undefined);

        assert.deepStrictEqual(ids((manager as any).collection), ['RECOVERED']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'RECOVERED', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('does not attribute a concurrent create to a scoped refresh while loading the project map', async () => {
        const manager = createManager();
        seed(manager, []);

        findVirtualEnvironmentsStub.resolves([makeEnv('A', venvARoot)]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inLoadEnvMap.promise;
        (manager as any).addEnvironment(makeEnv('CREATED', path.join(ROOT, 'created', '.venv')), true);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['A', 'CREATED']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'CREATED', kind: EnvironmentChangeKind.add }], [{ id: 'A', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('does not attribute a concurrent create to a full refresh while loading the project map', async () => {
        const manager = createManager();
        seed(manager, [makeEnv('OLD', venvBRoot)]);

        findVirtualEnvironmentsStub.resolves([makeEnv('A', venvARoot)]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inLoadEnvMap.promise;
        (manager as any).addEnvironment(makeEnv('CREATED', path.join(ROOT, 'created', '.venv')), true);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['A', 'CREATED']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [{ id: 'CREATED', kind: EnvironmentChangeKind.add }],
                [
                    { id: 'OLD', kind: EnvironmentChangeKind.remove },
                    { id: 'A', kind: EnvironmentChangeKind.add },
                ],
            ],
        );
    });

    test('does not publish a stale add when a scoped refresh discovery is removed during project map loading', async () => {
        const manager = createManager();
        seed(manager, []);

        const envA = makeEnv('A', venvARoot);
        findVirtualEnvironmentsStub.resolves([envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inLoadEnvMap.promise;
        await manager.remove(envA);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }]],
        );
    });

    test('does not emit a duplicate add when a discovered env is removed and recreated with the same id during project map loading', async () => {
        const manager = createManager();
        seed(manager, []);

        const envA = makeEnv('A', venvARoot);
        findVirtualEnvironmentsStub.resolves([envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const recreated = makeEnv('A', venvARoot);
        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inLoadEnvMap.promise;
        await manager.remove(envA);
        (manager as any).addEnvironment(recreated, true);
        release.resolve();
        await pRefresh;

        assert.strictEqual((manager as any).collection.length, 1);
        assert.strictEqual((manager as any).collection[0], recreated);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }], [{ id: 'A', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('does not duplicate a full-refresh remove when a direct remove completes during project map loading', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        findVirtualEnvironmentsStub.resolves([envA]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inLoadEnvMap.promise;
        await manager.remove(envA);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }]],
        );
    });

    test('emits a directly removed env once while republishing surviving envs during a full refresh', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envA, envB]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        findVirtualEnvironmentsStub.resolves([envA, envB]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inLoadEnvMap.promise;
        await manager.remove(envA);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['B']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [{ id: 'A', kind: EnvironmentChangeKind.remove }],
                [
                    { id: 'B', kind: EnvironmentChangeKind.remove },
                    { id: 'B', kind: EnvironmentChangeKind.add },
                ],
            ],
        );
    });

    test('does not duplicate a replacement remove when a direct create replaces an env during full-refresh map loading', async () => {
        const manager = createManager();
        const envAOld = makeEnv('A-old', venvARoot);
        const envB = makeEnv('B', venvBRoot);
        seed(manager, [envAOld, envB]);

        findVirtualEnvironmentsStub.resolves([envAOld, envB]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const envANew = makeEnv('A-new', venvARoot);
        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inLoadEnvMap.promise;
        (manager as any).addEnvironment(envANew, true);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'B']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [
                    { id: 'A-old', kind: EnvironmentChangeKind.remove },
                    { id: 'A-new', kind: EnvironmentChangeKind.add },
                ],
                [
                    { id: 'B', kind: EnvironmentChangeKind.remove },
                    { id: 'B', kind: EnvironmentChangeKind.add },
                ],
            ],
        );
    });

    test('does not duplicate a scoped remove when a direct remove completes during project map loading', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        findVirtualEnvironmentsStub.resolves([envA]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inLoadEnvMap.promise;
        await manager.remove(envA);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }]],
        );
    });

    test('emits the refresh remove for a distinct old object when a direct remove targets a same-path replacement during full-refresh map loading', async () => {
        const manager = createManager();
        const envOld = makeEnv('A', venvARoot);
        seed(manager, [envOld]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const envDiscovered = makeEnv('A', venvARoot);
        findVirtualEnvironmentsStub.resolves([envDiscovered]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inLoadEnvMap.promise;
        await manager.remove(envDiscovered);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].length, 1);
        assert.strictEqual(events[0][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(events[0][0].environment, envDiscovered);
        assert.strictEqual(events[1].length, 1);
        assert.strictEqual(events[1][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(events[1][0].environment, envOld);
    });

    test('emits the refresh remove for a distinct old object when a direct remove targets a same-path scoped replacement during map loading', async () => {
        const manager = createManager();
        const envOld = makeEnv('A', venvARoot);
        seed(manager, [envOld]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const envDiscovered = makeEnv('A', venvARoot);
        findVirtualEnvironmentsStub.resolves([envDiscovered]);

        const inLoadEnvMap = createDeferred<void>();
        const release = createDeferred<void>();
        let call = 0;
        ((manager as any).baseManager.getEnvironments as sinon.SinonStub).callsFake(async () => {
            call += 1;
            if (call === 1) {
                inLoadEnvMap.resolve();
                await release.promise;
            }
            return [];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inLoadEnvMap.promise;
        await manager.remove(envDiscovered);
        release.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].length, 1);
        assert.strictEqual(events[0][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(events[0][0].environment, envDiscovered);
        assert.strictEqual(events[1].length, 1);
        assert.strictEqual(events[1][0].kind, EnvironmentChangeKind.remove);
        assert.strictEqual(events[1][0].environment, envOld);
    });

    test('discards a stale scoped discovery when a direct remove mutates the collection during discovery', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        findVirtualEnvironmentsStub.callsFake(async () => {
            inDiscovery.resolve();
            await releaseDiscovery.promise;
            return [envA];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inDiscovery.promise;
        await manager.remove(envA);
        releaseDiscovery.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }]],
        );
    });

    test('discards a stale full refresh when a direct remove mutates the collection during discovery', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        findVirtualEnvironmentsStub.callsFake(async () => {
            inDiscovery.resolve();
            await releaseDiscovery.promise;
            return [envA];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inDiscovery.promise;
        await manager.remove(envA);
        releaseDiscovery.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), []);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'A', kind: EnvironmentChangeKind.remove }]],
        );
    });

    test('discards a stale scoped discovery when a direct create mutates the collection during discovery', async () => {
        const manager = createManager();
        seed(manager, []);

        const envA = makeEnv('A', venvARoot);
        const created = makeEnv('CREATED', path.join(ROOT, 'created', '.venv'));
        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        findVirtualEnvironmentsStub.callsFake(async () => {
            inDiscovery.resolve();
            await releaseDiscovery.promise;
            return [envA];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inDiscovery.promise;
        (manager as any).addEnvironment(created, true);
        releaseDiscovery.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['CREATED']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'CREATED', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('resumes on a later refresh after discarding a stale discovery result', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);
        sinon.stub(venvUtils, 'removeVenv').resolves(true);

        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        let call = 0;
        findVirtualEnvironmentsStub.callsFake(async () => {
            call += 1;
            if (call === 1) {
                inDiscovery.resolve();
                await releaseDiscovery.promise;
                return [envA];
            }
            return [makeEnv('A-new', venvARoot)];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inDiscovery.promise;
        await manager.remove(envA);
        releaseDiscovery.resolve();
        await pRefresh;

        await manager.refresh(Uri.file(folderA));

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [{ id: 'A', kind: EnvironmentChangeKind.remove }],
                [{ id: 'A-new', kind: EnvironmentChangeKind.add }],
            ],
        );
    });

    test('emits the global add and discards a stale full refresh when setting the global env mutates the collection during discovery', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        seed(manager, [envA]);

        const globalEnv = makeEnv('G', globalVenvRoot);
        sinon.stub(venvUtils, 'setVenvForGlobal').resolves();
        (venvUtils.getVenvForGlobal as sinon.SinonStub).resolves(venvPython(globalVenvRoot));
        (venvUtils.resolveVenvPythonEnvironmentPath as sinon.SinonStub).resolves(globalEnv);

        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        findVirtualEnvironmentsStub.callsFake(async () => {
            inDiscovery.resolve();
            await releaseDiscovery.promise;
            return [makeEnv('A-STALE', venvARoot)];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(undefined);
        await inDiscovery.promise;
        await manager.set(undefined, globalEnv);
        releaseDiscovery.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['A', 'G']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [[{ id: 'G', kind: EnvironmentChangeKind.add }]],
        );
    });

    test('selecting an already-collected global emits no add and does not discard a concurrent scoped refresh', async () => {
        const manager = createManager();
        const envA = makeEnv('A', venvARoot);
        const globalEnv = makeEnv('G', globalVenvRoot);
        seed(manager, [envA, globalEnv]);

        sinon.stub(venvUtils, 'setVenvForGlobal').resolves();
        (venvUtils.getVenvForGlobal as sinon.SinonStub).resolves(venvPython(globalVenvRoot));

        const inDiscovery = createDeferred<void>();
        const releaseDiscovery = createDeferred<void>();
        findVirtualEnvironmentsStub.callsFake(async () => {
            inDiscovery.resolve();
            await releaseDiscovery.promise;
            return [makeEnv('A-new', venvARoot)];
        });

        const events = captureEvents(manager);
        const pRefresh = manager.refresh(Uri.file(folderA));
        await inDiscovery.promise;
        await manager.set(undefined, globalEnv);
        releaseDiscovery.resolve();
        await pRefresh;

        assert.deepStrictEqual(ids((manager as any).collection), ['A-new', 'G']);
        assert.deepStrictEqual(
            events.map((batch) => batch.map((c) => ({ id: c.environment.envId.id, kind: c.kind }))),
            [
                [
                    { id: 'A', kind: EnvironmentChangeKind.remove },
                    { id: 'A-new', kind: EnvironmentChangeKind.add },
                ],
            ],
        );
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
        const removed = changes
            .filter((c) => c.kind === EnvironmentChangeKind.remove)
            .map((c) => c.environment.envId.id);
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

    test('resolves a file scope to its directory before invoking the native finder', async () => {
        findVirtualEnvironmentsStub.restore();
        const finderRefresh = sinon.stub().resolves([]);
        const manager = createManager({ refresh: finderRefresh } as unknown as NativePythonFinder);
        seed(manager, []);

        const fileUri = Uri.file(path.join(folderA, 'main.py'));
        findParentIfFileStub.callsFake(async () => folderA);

        await manager.refresh(fileUri);

        assert.ok(finderRefresh.calledOnce);
        const uris = finderRefresh.firstCall.args[1] as Uri[] | undefined;
        assert.ok(Array.isArray(uris) && uris.length === 1);
        assert.strictEqual(uris[0].fsPath, Uri.file(folderA).fsPath);
    });

    function createManager(finder: NativePythonFinder = {} as NativePythonFinder): VenvManager {
        const api = {
            getEnvironments: sinon.stub().resolves([]),
            getPythonProject: sinon.stub().returns(undefined),
            getPythonProjects: sinon.stub().returns([]),
            refreshEnvironments: sinon.stub().resolves(undefined),
        } as any as PythonEnvironmentApi;
        const baseManager = {
            getEnvironments: sinon.stub().resolves([]),
        } as any as EnvironmentManager;
        const manager = new VenvManager(finder, api, baseManager, {
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
});

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
