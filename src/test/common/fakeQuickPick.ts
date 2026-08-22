// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { when } from 'ts-mockito';
import {
    EventEmitter,
    QuickInputButton,
    QuickPick,
    QuickPickItem,
    QuickPickItemButtonEvent,
} from 'vscode';
import { mockedVSCodeNamespaces } from '../unittests';

/**
 * A lightweight, fully controllable stand-in for a VS Code {@link QuickPick} so unit tests can
 * exercise the {@link showQuickPickWithButtons} lifecycle and the streaming environment picker
 * without a real window. Events are backed by real {@link EventEmitter}s and the class exposes
 * `accept`/`triggerButton`/`cancel` helpers to drive user interactions deterministically.
 */
export class FakeQuickPick<T extends QuickPickItem> {
    private _items: readonly T[] = [];
    /**
     * Models VS Code's real behavior: assigning `items` moves focus to the first item and clears the
     * (multi-select) selection. Callers that need to preserve the active/selected item must re-apply
     * it *after* assigning items — which is exactly what the `showQuickPickWithButtons` controller
     * does. Modeling this faithfully prevents false-positive "preserves by reference" tests.
     */
    public get items(): readonly T[] {
        return this._items;
    }
    public set items(value: readonly T[]) {
        this._items = value;
        this.activeItems = value.length > 0 ? [value[0]] : [];
        this.selectedItems = [];
    }
    public activeItems: readonly T[] = [];
    public selectedItems: readonly T[] = [];
    public value = '';
    public placeholder: string | undefined;
    public title: string | undefined;
    public busy = false;
    public enabled = true;
    public canSelectMany = false;
    public ignoreFocusOut = false;
    public matchOnDescription = false;
    public matchOnDetail = false;
    public keepScrollPosition = false;
    public buttons: readonly QuickInputButton[] = [];
    public step: number | undefined;
    public totalSteps: number | undefined;

    public shown = false;
    public disposed = false;

    private readonly _onDidAccept = new EventEmitter<void>();
    private readonly _onDidHide = new EventEmitter<void>();
    private readonly _onDidChangeValue = new EventEmitter<string>();
    private readonly _onDidChangeActive = new EventEmitter<readonly T[]>();
    private readonly _onDidChangeSelection = new EventEmitter<readonly T[]>();
    private readonly _onDidTriggerButton = new EventEmitter<QuickInputButton>();
    private readonly _onDidTriggerItemButton = new EventEmitter<QuickPickItemButtonEvent<T>>();

    public readonly onDidAccept = this._onDidAccept.event;
    public readonly onDidHide = this._onDidHide.event;
    public readonly onDidChangeValue = this._onDidChangeValue.event;
    public readonly onDidChangeActive = this._onDidChangeActive.event;
    public readonly onDidChangeSelection = this._onDidChangeSelection.event;
    public readonly onDidTriggerButton = this._onDidTriggerButton.event;
    public readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event;

    public show(): void {
        this.shown = true;
    }

    public hide(): void {
        this._onDidHide.fire();
    }

    public dispose(): void {
        this.disposed = true;
    }

    /** Simulate the user accepting the picker, optionally selecting `item` first. */
    public accept(item?: T): void {
        if (item) {
            this.selectedItems = [item];
        }
        this._onDidAccept.fire();
    }

    /** Simulate the user pressing a title button (e.g. the Back button). */
    public triggerButton(button: QuickInputButton): void {
        this._onDidTriggerButton.fire(button);
    }

    /** Simulate the picker being dismissed without a selection. */
    public cancel(): void {
        this.hide();
    }

    public asQuickPick(): QuickPick<T> {
        return this as unknown as QuickPick<T>;
    }
}

/**
 * Registers a fresh {@link FakeQuickPick} to be returned from the next `window.createQuickPick()`
 * call and returns it for the test to drive. The most recent registration wins.
 */
export function useFakeQuickPick<T extends QuickPickItem>(): FakeQuickPick<T> {
    const fake = new FakeQuickPick<T>();
    when(mockedVSCodeNamespaces.window!.createQuickPick<T>()).thenReturn(fake.asQuickPick());
    return fake;
}

/** Flushes pending microtasks and immediates so streamed picker updates settle. */
export function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
