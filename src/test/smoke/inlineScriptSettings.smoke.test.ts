// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { latchInlineScriptFeatureActivation } from '../../features/inlineScript/activation';
import { isInlineScriptsFeatureEnabled } from '../../helpers';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForCondition } from '../testUtils';

suite('Smoke: Inline-script setting precedence', function () {
    this.timeout(30000);

    const expectedDefault = process.env.VSC_PYTHON_INLINE_SCRIPTS_DEFAULT === 'true';
    const config = () => vscode.workspace.getConfiguration('python-envs');

    suiteSetup(async () => {
        assert.ok(vscode.extensions.getExtension(ENVS_EXTENSION_ID), 'The development extension must be installed');
        assert.ok(vscode.workspace.workspaceFolders?.length, 'The settings test host must have an open workspace');
        await waitForCondition(
            () => config().inspect<boolean>('inlineScripts.enabled')?.defaultValue === expectedDefault,
            10000,
            () =>
                `Expected startup default ${expectedDefault}, got ` +
                `${config().inspect<boolean>('inlineScripts.enabled')?.defaultValue}; ` +
                `effective setting: ${isInlineScriptsFeatureEnabled()}; developer overrides: ` +
                JSON.stringify(vscode.workspace.getConfiguration().get('experiments.override')),
        );
    });

    teardown(async () => {
        await config().update('inlineScripts.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        await config().update('inlineScripts.enabled', undefined, vscode.ConfigurationTarget.Global);
    });

    test('reads the package or experimental default when no explicit value is configured', () => {
        const inspected = config().inspect<boolean>('inlineScripts.enabled');
        assert.ok(inspected);
        assert.strictEqual(inspected.globalValue, undefined);
        assert.strictEqual(inspected.workspaceValue, undefined);
        assert.strictEqual(inspected.defaultValue, expectedDefault);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), expectedDefault);
    });

    test('an explicit user opt-out overrides the experimental default', async () => {
        await config().update('inlineScripts.enabled', false, vscode.ConfigurationTarget.Global);

        assert.strictEqual(config().inspect<boolean>('inlineScripts.enabled')?.defaultValue, expectedDefault);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), false);
    });

    test('an explicit user opt-in overrides the experimental default', async () => {
        await config().update('inlineScripts.enabled', true, vscode.ConfigurationTarget.Global);

        assert.strictEqual(config().inspect<boolean>('inlineScripts.enabled')?.defaultValue, expectedDefault);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), true);
    });

    for (const workspaceValue of [false, true]) {
        test(`workspace ${workspaceValue} overrides user ${!workspaceValue} and the experimental default`, async () => {
            await config().update('inlineScripts.enabled', !workspaceValue, vscode.ConfigurationTarget.Global);
            await config().update('inlineScripts.enabled', workspaceValue, vscode.ConfigurationTarget.Workspace);

            assert.strictEqual(config().inspect<boolean>('inlineScripts.enabled')?.workspaceValue, workspaceValue);
            assert.strictEqual(isInlineScriptsFeatureEnabled(), workspaceValue);
        });
    }

    test('removing explicit values restores the package or experimental default', async () => {
        await config().update('inlineScripts.enabled', !expectedDefault, vscode.ConfigurationTarget.Global);
        await config().update('inlineScripts.enabled', !expectedDefault, vscode.ConfigurationTarget.Workspace);
        assert.strictEqual(isInlineScriptsFeatureEnabled(), !expectedDefault);

        await config().update('inlineScripts.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        await config().update('inlineScripts.enabled', undefined, vscode.ConfigurationTarget.Global);

        assert.strictEqual(isInlineScriptsFeatureEnabled(), expectedDefault);
    });

    test('a setting change does not change an existing activation snapshot', async () => {
        const activation = latchInlineScriptFeatureActivation();
        try {
            await config().update('inlineScripts.enabled', !expectedDefault, vscode.ConfigurationTarget.Global);

            assert.strictEqual(isInlineScriptsFeatureEnabled(), !expectedDefault);
            assert.strictEqual(activation.enabled, expectedDefault);
            const nextActivation = latchInlineScriptFeatureActivation();
            try {
                assert.strictEqual(nextActivation.enabled, !expectedDefault);
            } finally {
                nextActivation.routingRegistry?.dispose();
            }
        } finally {
            activation.routingRegistry?.dispose();
        }
    });
});
