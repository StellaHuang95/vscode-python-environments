// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { QuickPickItem } from 'vscode';
import { PythonEnvironment } from '../../api';
import * as logging from '../../common/logging';
import { Common, Interpreter } from '../../common/localize';
import { pickEnvironment } from '../../common/pickers/environments';
import { createDeferred } from '../../common/utils/deferred';
import { InternalEnvironmentManager } from '../../internal.api';
import { FakeQuickPick, flush, useFakeQuickPick } from './fakeQuickPick';

function makeEnv(id: string, execPath: string, displayName = id, managerId = 'test-manager'): PythonEnvironment {
    return {
        envId: { id, managerId },
        name: id,
        displayName,
        displayPath: execPath,
        execInfo: { run: { executable: execPath } },
    } as unknown as PythonEnvironment;
}

interface ControllableManager {
    manager: InternalEnvironmentManager;
    resolve: (envs: PythonEnvironment[]) => void;
    reject: (err: unknown) => void;
}

function controllableManager(id: string, displayName = id): ControllableManager {
    const deferred = createDeferred<PythonEnvironment[]>();
    const manager = {
        id,
        displayName,
        getEnvironments: () => deferred.promise,
        refresh: async () => {},
    } as unknown as InternalEnvironmentManager;
    return {
        manager,
        resolve: (envs) => deferred.resolve(envs),
        reject: (err) => deferred.reject(err),
    };
}

suite('pickEnvironment - opens promptly and isolates manager failures', () => {
    let fake: FakeQuickPick<QuickPickItem>;
    let traceErrorStub: sinon.SinonStub;

    const STATIC_LABELS = [Interpreter.browsePath, '', Interpreter.createVirtualEnvironment];
    const labels = (): string[] => fake.items.map((i) => i.label);

    setup(() => {
        fake = useFakeQuickPick<QuickPickItem>();
        traceErrorStub = sinon.stub(logging, 'traceError');
        sinon.stub(logging, 'traceInfo');
        sinon.stub(logging, 'traceVerbose');
        sinon.stub(logging, 'traceWarn');
        sinon.stub(logging, 'traceLog');
    });

    teardown(() => {
        sinon.restore();
    });

    test('opens immediately with browse/create before any manager resolves', async () => {
        const m1 = controllableManager('m1', 'Manager One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        assert.ok(fake.shown, 'picker should be shown before slow managers resolve');
        assert.strictEqual(fake.busy, true, 'picker should be busy while managers load');
        assert.deepStrictEqual(labels(), STATIC_LABELS);

        m1.resolve([makeEnv('env-1', '/p/env-1')]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Manager One', 'env-1']);
        assert.strictEqual(fake.busy, false, 'busy should clear once all loads settle');

        fake.accept(fake.items.find((i) => i.label === 'env-1')!);
        const result = await pick;
        assert.strictEqual(result?.envId.id, 'env-1');
    });

    test('keeps fixed manager order regardless of completion order', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m2.resolve([makeEnv('e2', '/p/e2')]);
        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'One', 'e1', 'Two', 'e2']);

        fake.cancel();
        await pick;
    });

    test('one manager failing does not hide the others and is logged', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.reject(new Error('boom'));
        m2.resolve([makeEnv('e2', '/p/e2')]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Two', 'e2'], 'the surviving manager still shows');
        assert.ok(
            traceErrorStub.getCalls().some((c) => String(c.args[0]).includes('"m1"')),
            'the failed manager id should be logged',
        );

        fake.accept(fake.items.find((i) => i.label === 'e2')!);
        const result = await pick;
        assert.strictEqual(result?.envId.id, 'e2');
    });

    test('every manager failing still leaves a usable browse/create picker', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.reject(new Error('boom-1'));
        m2.reject(new Error('boom-2'));
        await flush();

        assert.deepStrictEqual(labels(), STATIC_LABELS, 'only browse/create remain when all managers fail');
        assert.strictEqual(fake.busy, false, 'busy clears even when every manager fails');
        assert.strictEqual(
            traceErrorStub.getCalls().filter((c) => String(c.args[0]).includes('Failed to load')).length,
            2,
            'each failed manager is logged',
        );

        fake.cancel();
        assert.strictEqual(await pick, undefined, 'the picker can still be dismissed');
    });

    test('shows a synchronous recommended environment immediately', async () => {
        const m1 = controllableManager('m1', 'One');
        const recommended = makeEnv('rec', '/p/rec', 'Recommended Env');
        const pick = pickEnvironment([m1.manager], [], { projects: [], recommended });

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, Common.recommended, 'Recommended Env']);

        m1.resolve([]);
        await flush();
        fake.cancel();
        await pick;
    });

    test('an empty manager list opens and settles with only browse/create', async () => {
        const pick = pickEnvironment([], [], { projects: [] });

        assert.deepStrictEqual(labels(), STATIC_LABELS);
        await flush();
        assert.strictEqual(fake.busy, false);

        fake.cancel();
        assert.strictEqual(await pick, undefined);
    });

    test('late manager results after the picker closes are ignored', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        fake.cancel();
        assert.strictEqual(await pick, undefined);

        m1.resolve([makeEnv('late', '/p/late')]);
        await flush();
        assert.deepStrictEqual(labels(), STATIC_LABELS, 'no items should be added after the picker closed');
    });
});
