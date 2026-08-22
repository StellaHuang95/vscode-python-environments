// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import { CancellationTokenSource, QuickInputButton, QuickInputButtons, QuickPickItem } from 'vscode';
import { QuickPickController, showQuickPickWithButtons } from '../../common/window.apis';
import { flush, useFakeQuickPick } from './fakeQuickPick';

suite('showQuickPickWithButtons - onDidShow controller seam', () => {
    test('static callers (no onDidShow): accept resolves with the selected item', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const items: QuickPickItem[] = [{ label: 'x' }, { label: 'y' }];

        const promise = showQuickPickWithButtons(items);
        await flush();

        assert.ok(fake.shown, 'quick pick should be shown');
        assert.deepStrictEqual(fake.items, items, 'items should be assigned up front');

        fake.accept(items[1]);
        assert.strictEqual(await promise, items[1]);
        assert.ok(fake.disposed, 'quick pick should be disposed after settling');
    });

    test('static callers: hide resolves with undefined', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const promise = showQuickPickWithButtons([{ label: 'x' }]);
        await flush();

        fake.cancel();
        assert.strictEqual(await promise, undefined);
    });

    test('static callers: Back button rejects with QuickInputButtons.Back', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const promise = showQuickPickWithButtons([{ label: 'x' }], { showBackButton: true });
        await flush();

        assert.deepStrictEqual(fake.buttons, [QuickInputButtons.Back], 'back button should be wired');

        fake.triggerButton(QuickInputButtons.Back);
        await assert.rejects(
            () => promise,
            (err: unknown) => err === QuickInputButtons.Back,
        );
    });

    test('static callers: custom button rejects with { item, button }', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const button = { iconPath: undefined } as unknown as QuickInputButton;
        const items: QuickPickItem[] = [{ label: 'x' }];

        const promise = showQuickPickWithButtons(items, { buttons: [button] });
        await flush();

        fake.selectedItems = [items[0]];
        fake.triggerButton(button);

        await assert.rejects(
            () => promise,
            (err: unknown) => {
                const e = err as { item: QuickPickItem[]; button: QuickInputButton };
                assert.strictEqual(e.button, button);
                assert.ok(Array.isArray(e.item));
                return true;
            },
        );
    });

    test('static callers: token cancellation hides and resolves undefined', async () => {
        useFakeQuickPick<QuickPickItem>();
        const cts = new CancellationTokenSource();

        const promise = showQuickPickWithButtons([{ label: 'x' }], {}, cts.token);
        await flush();

        cts.cancel();
        assert.strictEqual(await promise, undefined);
    });

    test('onDidShow receives a live controller that can stream items and toggle busy', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const items: QuickPickItem[] = [{ label: 'a' }, { label: 'b' }];
        let controller: QuickPickController<QuickPickItem> | undefined;

        const promise = showQuickPickWithButtons(items, {
            onDidShow: (c) => {
                controller = c;
            },
        });
        await flush();

        assert.ok(controller, 'controller should be delivered after show');
        assert.strictEqual(controller!.settled, false);

        controller!.setBusy(true);
        assert.strictEqual(fake.busy, true, 'setBusy should update the quick pick');

        const extended: QuickPickItem[] = [...items, { label: 'c' }];
        controller!.setItems(extended);
        assert.strictEqual(fake.items.length, 3, 'setItems should replace the item list');

        fake.accept(items[0]);
        assert.strictEqual(await promise, items[0]);
        assert.strictEqual(controller!.settled, true, 'controller should be settled after acceptance');
    });

    test('setItems preserves active and selected items by reference', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const a: QuickPickItem = { label: 'a' };
        const b: QuickPickItem = { label: 'b' };
        const c: QuickPickItem = { label: 'c' };
        let controller: QuickPickController<QuickPickItem> | undefined;

        const promise = showQuickPickWithButtons([a, b], {
            onDidShow: (ctl) => {
                controller = ctl;
            },
        });
        await flush();

        // User navigates to `b` and selects it.
        fake.activeItems = [b];
        fake.selectedItems = [b];

        controller!.setItems([a, b, c]);

        assert.strictEqual(fake.activeItems[0], b, 'active item should be preserved by reference');
        assert.strictEqual(fake.selectedItems[0], b, 'selected item should be preserved by reference');

        fake.cancel();
        await promise;
    });

    test('controller mutations are ignored after the picker settles', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const items: QuickPickItem[] = [{ label: 'a' }];
        let controller: QuickPickController<QuickPickItem> | undefined;

        const promise = showQuickPickWithButtons(items, {
            onDidShow: (ctl) => {
                controller = ctl;
            },
        });
        await flush();

        controller!.setBusy(true);
        fake.cancel();
        assert.strictEqual(await promise, undefined);

        // Any late updates from background loaders must be no-ops.
        assert.strictEqual(controller!.settled, true);
        assert.doesNotThrow(() => controller!.setItems([{ label: 'late' }]));
        assert.doesNotThrow(() => controller!.setBusy(false));
        assert.strictEqual(fake.busy, true, 'busy state must not change after settle');
        assert.deepStrictEqual(
            fake.items.map((i) => i.label),
            ['a'],
            'items must not change after settle',
        );
    });

    test('setItems keeps the scroll position so streaming does not jump the list', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        let controller: QuickPickController<QuickPickItem> | undefined;

        const promise = showQuickPickWithButtons([{ label: 'a' }], {
            onDidShow: (ctl) => {
                controller = ctl;
            },
        });
        await flush();

        assert.strictEqual(fake.keepScrollPosition, false, 'scroll position is not pinned before streaming');
        controller!.setItems([{ label: 'a' }, { label: 'b' }]);
        assert.strictEqual(fake.keepScrollPosition, true, 'streaming updates should keep the scroll position');

        fake.cancel();
        await promise;
    });

    test('a synchronous throw from onDidShow still disposes the quick pick', async () => {
        const fake = useFakeQuickPick<QuickPickItem>();
        const boom = new Error('onDidShow boom');

        const promise = showQuickPickWithButtons([{ label: 'a' }], {
            onDidShow: () => {
                throw boom;
            },
        });

        await assert.rejects(
            () => promise,
            (err: unknown) => err === boom,
        );
        assert.ok(fake.disposed, 'the quick pick must be disposed even when onDidShow throws');
    });
});
