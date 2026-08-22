// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { QuickInputButtons, QuickPickItem } from 'vscode';
import { PythonEnvironment } from '../../api';
import * as logging from '../../common/logging';
import { pickEnvironment } from '../../common/pickers/environments';
import { Common, Interpreter } from '../../common/localize';
import { createDeferred } from '../../common/utils/deferred';
import { InternalEnvironmentManager } from '../../internal.api';
import { FakeQuickPick, flush, useFakeQuickPick } from './fakeQuickPick';

function makeEnv(id: string, execPath: string, displayName = id): PythonEnvironment {
    return {
        envId: { id, managerId: 'test-manager' },
        name: id,
        displayName,
        displayPath: execPath,
        execInfo: { run: { executable: execPath } },
    } as unknown as PythonEnvironment;
}

/**
 * Builds an environment with a distinct prefix (`environmentPath`) that may share a launcher
 * executable with other environments — models Python-less Conda prefixes sharing one `conda` binary.
 */
function makeEnvWithPrefix(id: string, prefix: string, execPath: string, displayName = id): PythonEnvironment {
    return {
        envId: { id, managerId: 'test-manager' },
        name: id,
        displayName,
        displayPath: prefix,
        environmentPath: { fsPath: prefix },
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

suite('pickEnvironment - streaming environment sections', () => {
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

    test('shows immediately with browse/create before any manager resolves', async () => {
        const m1 = controllableManager('m1', 'Manager One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        // onDidShow runs synchronously, so the picker is visible with static items right away.
        assert.ok(fake.shown, 'picker should be shown before slow managers resolve');
        assert.strictEqual(fake.busy, true, 'picker should be busy while managers load');
        assert.deepStrictEqual(labels(), STATIC_LABELS);

        const env = makeEnv('env-1', '/p/env-1');
        m1.resolve([env]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Manager One', 'env-1']);
        assert.strictEqual(fake.busy, false, 'busy should clear once all loads settle');

        const item = fake.items.find((i) => i.label === 'env-1')!;
        fake.accept(item);
        const result = await pick;
        assert.strictEqual(result?.envId.id, 'env-1');
    });

    test('sections keep fixed manager order even when a later manager resolves first', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        // Second manager finishes first.
        m2.resolve([makeEnv('e2', '/p/e2')]);
        await flush();
        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Two', 'e2'], 'only the resolved section shows');

        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();
        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, 'One', 'e1', 'Two', 'e2'],
            'manager One section must precede Two regardless of completion order',
        );

        fake.cancel();
        await pick;
    });

    test('deduplicates the same environment across managers (earlier manager wins)', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.resolve([makeEnv('a', '/p/shared'), makeEnv('b', '/p/b')]);
        m2.resolve([makeEnv('a-dup', '/p/shared'), makeEnv('c', '/p/c')]);
        await flush();

        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, 'One', 'a', 'b', 'Two', 'c'],
            'duplicate /p/shared should only appear under the first manager',
        );

        fake.cancel();
        await pick;
    });

    test('recommended environment is not duplicated in its manager section', async () => {
        const recommended = makeEnv('rec', '/p/rec', 'Recommended Env');
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [], recommended });

        assert.deepStrictEqual(labels(), [
            ...STATIC_LABELS,
            Common.recommended,
            'Recommended Env',
        ]);

        m1.resolve([makeEnv('rec-dup', '/p/rec'), makeEnv('other', '/p/other')]);
        await flush();

        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, Common.recommended, 'Recommended Env', 'One', 'other'],
            'the recommended env must be skipped in the manager section',
        );

        fake.cancel();
        await pick;
    });

    test('active and selected items are preserved by reference as sections stream in', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();

        const e1Item = fake.items.find((i) => i.label === 'e1')!;
        fake.activeItems = [e1Item];
        fake.selectedItems = [e1Item];

        m2.resolve([makeEnv('e2', '/p/e2')]);
        await flush();

        assert.strictEqual(fake.activeItems[0], e1Item, 'active item reference should survive rebuild');
        assert.strictEqual(fake.selectedItems[0], e1Item, 'selected item reference should survive rebuild');

        fake.cancel();
        await pick;
    });

    test('reuses item object references across rebuilds', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();
        const firstRef = fake.items.find((i) => i.label === 'e1')!;

        m2.resolve([makeEnv('e2', '/p/e2')]);
        await flush();
        const secondRef = fake.items.find((i) => i.label === 'e1')!;

        assert.strictEqual(firstRef, secondRef, 'the e1 item should be the same object across rebuilds');

        fake.cancel();
        await pick;
    });

    test('a failing manager is isolated, logged, and omitted from the picker', async () => {
        const m1 = controllableManager('m1', 'One');
        const m2 = controllableManager('m2', 'Two');
        const pick = pickEnvironment([m1.manager, m2.manager], [], { projects: [] });

        m1.reject(new Error('discovery failed'));
        m2.resolve([makeEnv('e2', '/p/e2')]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Two', 'e2'], 'failed section must be omitted');
        assert.strictEqual(fake.busy, false, 'busy clears even when a manager fails');
        assert.ok(
            traceErrorStub.getCalls().some((c) => typeof c.args[0] === 'string' && (c.args[0] as string).includes('m1')),
            'the failing manager id should be logged',
        );

        fake.cancel();
        await pick;
    });

    test('accepting an environment resolves with that environment', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });
        m1.resolve([makeEnv('chosen', '/p/chosen')]);
        await flush();

        fake.accept(fake.items.find((i) => i.label === 'chosen')!);
        const result = await pick;
        assert.strictEqual(result?.envId.id, 'chosen');
    });

    test('the Back button rejects with QuickInputButtons.Back', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [], showBackButton: true });

        fake.triggerButton(QuickInputButtons.Back);
        await assert.rejects(
            () => pick,
            (err: unknown) => err === QuickInputButtons.Back,
        );

        // Late resolution of the still-pending loader must not throw.
        m1.resolve([makeEnv('late', '/p/late')]);
        await flush();
    });

    test('cancelling the picker resolves with undefined', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        fake.cancel();
        assert.strictEqual(await pick, undefined);

        m1.resolve([makeEnv('late', '/p/late')]);
        await flush();
    });

    test('closing before managers resolve prevents any later mutation', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        assert.deepStrictEqual(labels(), STATIC_LABELS);
        fake.cancel();
        assert.strictEqual(await pick, undefined);
        assert.ok(fake.disposed, 'picker should be disposed after cancel');

        const itemsAfterClose = labels();
        m1.resolve([makeEnv('late', '/p/late')]);
        await flush();

        assert.deepStrictEqual(labels(), itemsAfterClose, 'items must not change after the picker closes');
    });

    test('distinct prefix environments sharing one launcher are not collapsed', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], { projects: [] });

        // Two Python-less Conda environments at distinct prefixes that share the same conda launcher
        // executable must both be shown — identity keys off the prefix, not the shared launcher.
        const envA = makeEnvWithPrefix('condaA', '/opt/conda/envs/a', '/opt/conda/bin/conda', 'Conda A');
        const envB = makeEnvWithPrefix('condaB', '/opt/conda/envs/b', '/opt/conda/bin/conda', 'Conda B');
        m1.resolve([envA, envB]);
        await flush();

        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, 'One', 'Conda A', 'Conda B'],
            'distinct prefixes sharing a launcher must not be deduplicated',
        );

        fake.cancel();
        await pick;
    });

    test('a late higher-priority manager reuses the same item object and keeps it selected', async () => {
        // Alpha is higher priority (listed first) but resolves LATER; Beta is lower priority but
        // resolves first and publishes an environment the user then activates/selects.
        const mA = controllableManager('mA', 'Alpha');
        const mB = controllableManager('mB', 'Beta');
        const pick = pickEnvironment([mA.manager, mB.manager], [], { projects: [] });

        mB.resolve([makeEnv('beta-env', '/p/shared')]);
        await flush();
        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'Beta', 'beta-env']);

        const item = fake.items.find((i) => i.label === 'beta-env')!;
        fake.activeItems = [item];
        fake.selectedItems = [item];

        // Higher-priority Alpha resolves later with the same environment identity (/p/shared).
        mA.resolve([makeEnv('alpha-env', '/p/shared')]);
        await flush();

        // Ownership moves to Alpha's section and Beta's now-empty section is dropped.
        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, 'Alpha', 'alpha-env'],
            'ownership moves to the higher-priority manager and the duplicate section is removed',
        );
        // The very same object reference is reused (moved + updated in place), so the user's
        // active/selected item survives instead of being replaced-and-dropped.
        assert.strictEqual(fake.activeItems[0], item, 'active item object must be reused across the move');
        assert.strictEqual(fake.selectedItems[0], item, 'selected item object must be reused across the move');
        const moved = fake.items.find((i) => i.label === 'alpha-env')!;
        assert.strictEqual(moved, item, 'the moved item is the same object');
        assert.strictEqual(
            (item as unknown as { result: PythonEnvironment }).result.envId.id,
            'alpha-env',
            'the item now reflects the higher-priority Alpha environment',
        );

        fake.cancel();
        await pick;
    });

    test('a pending recommendation resolver does not delay opening or block the picker', async () => {
        const m1 = controllableManager('m1', 'One');
        const recDeferred = createDeferred<PythonEnvironment | undefined>();
        const pick = pickEnvironment([m1.manager], [], {
            projects: [],
            resolveRecommended: () => recDeferred.promise,
        });

        // Shown immediately with Browse/Create despite the pending recommendation and pending manager.
        assert.ok(fake.shown, 'picker shows without awaiting the recommendation');
        assert.deepStrictEqual(labels(), STATIC_LABELS);
        assert.strictEqual(fake.busy, true);

        // Resolves on user action without ever awaiting the recommendation.
        fake.cancel();
        assert.strictEqual(await pick, undefined);

        // A late recommendation/manager resolution after close must be a safe no-op.
        recDeferred.resolve(makeEnv('late-rec', '/p/late-rec'));
        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();
        assert.deepStrictEqual(labels(), STATIC_LABELS, 'no mutation after the picker closes');
    });

    test('a rejected recommendation resolver is isolated, logged, and does not reject the picker', async () => {
        const m1 = controllableManager('m1', 'One');
        const pick = pickEnvironment([m1.manager], [], {
            projects: [],
            resolveRecommended: () => Promise.reject(new Error('default manager get failed')),
        });

        m1.resolve([makeEnv('e1', '/p/e1')]);
        await flush();

        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'One', 'e1'], 'manager section still streams in');
        assert.strictEqual(fake.busy, false, 'busy clears even when the recommendation fails');
        assert.ok(
            traceErrorStub
                .getCalls()
                .some((c) => typeof c.args[0] === 'string' && (c.args[0] as string).includes('recommended')),
            'the recommendation failure should be logged',
        );

        fake.cancel();
        await pick;
    });

    test('a late recommendation appears after show and is deduped from manager sections', async () => {
        const m1 = controllableManager('m1', 'One');
        const recDeferred = createDeferred<PythonEnvironment | undefined>();
        const pick = pickEnvironment([m1.manager], [], {
            projects: [],
            resolveRecommended: () => recDeferred.promise,
        });

        // No recommended section yet (the synchronous seed was undefined).
        assert.deepStrictEqual(labels(), STATIC_LABELS);

        m1.resolve([makeEnv('shared', '/p/shared', 'Shared Env'), makeEnv('other', '/p/other', 'Other')]);
        await flush();
        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'One', 'Shared Env', 'Other']);

        // The recommendation resolves late to the shared environment: it appears at the top and is
        // removed from the manager section (dedup).
        recDeferred.resolve(makeEnv('shared-rec', '/p/shared', 'Shared Env'));
        await flush();
        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, Common.recommended, 'Shared Env', 'One', 'Other'],
            'late recommendation shows at top and is deduped from the manager section',
        );

        fake.cancel();
        await pick;
    });

    test('a late recommendation reuses the manager-section item object and keeps it selected', async () => {
        const m1 = controllableManager('m1', 'One');
        const recDeferred = createDeferred<PythonEnvironment | undefined>();
        const pick = pickEnvironment([m1.manager], [], {
            projects: [],
            resolveRecommended: () => recDeferred.promise,
        });

        // The environment first streams into the manager section and the user activates/selects it.
        m1.resolve([makeEnv('env-1', '/p/shared', 'Shared Env')]);
        await flush();
        assert.deepStrictEqual(labels(), [...STATIC_LABELS, 'One', 'Shared Env']);
        const item = fake.items.find((i) => i.label === 'Shared Env')!;
        fake.activeItems = [item];
        fake.selectedItems = [item];

        // A late recommendation resolves to the same environment identity: it is promoted to the
        // recommended slot reusing the SAME object, so the user's active/selected reference survives
        // the section -> recommended move instead of being replaced-and-dropped.
        recDeferred.resolve(makeEnv('env-1-rec', '/p/shared', 'Shared Env'));
        await flush();
        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, Common.recommended, 'Shared Env'],
            'the env moves to the recommended slot and is removed from the manager section',
        );
        assert.strictEqual(fake.activeItems[0], item, 'active item object must be reused across the promotion');
        assert.strictEqual(fake.selectedItems[0], item, 'selected item object must be reused across the promotion');
        assert.strictEqual(
            fake.items.find((i) => i.label === 'Shared Env')!,
            item,
            'the promoted item is the same object',
        );
        assert.strictEqual(
            (item as unknown as { result: PythonEnvironment }).result.envId.id,
            'env-1-rec',
            'the item now reflects the authoritative recommended environment',
        );

        fake.cancel();
        await pick;
    });

    test('an authoritative resolver returning undefined clears a stale seeded recommendation', async () => {
        const m1 = controllableManager('m1', 'One');
        const recDeferred = createDeferred<PythonEnvironment | undefined>();
        const pick = pickEnvironment([m1.manager], [], {
            projects: [],
            recommended: makeEnv('stale', '/p/stale', 'Stale Rec'),
            resolveRecommended: () => recDeferred.promise,
        });

        // The synchronous seed is shown as the recommendation immediately.
        assert.deepStrictEqual(labels(), [...STATIC_LABELS, Common.recommended, 'Stale Rec']);

        m1.resolve([makeEnv('e1', '/p/e1', 'Env One')]);
        await flush();

        // The authoritative resolver returns undefined: the stale seed is cleared, matching the
        // pre-streaming behavior where the awaited manager.get() was the sole source.
        recDeferred.resolve(undefined);
        await flush();
        assert.deepStrictEqual(
            labels(),
            [...STATIC_LABELS, 'One', 'Env One'],
            'an undefined authoritative recommendation removes the stale seed',
        );

        fake.cancel();
        await pick;
    });
});
