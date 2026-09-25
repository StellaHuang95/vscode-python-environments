// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { Disposable, ExtensionContext, Uri } from 'vscode';
import * as commandApis from '../../common/command.api';
import { registerInstallerTestCommands } from '../../features/installerTestCommands';
import * as installer from '../../managers/builtin/pythonInstaller';
import { UV_INSTALL_PYTHON_DONT_ASK_KEY } from '../../managers/builtin/uvPythonInstaller';
import { createMockLogOutputChannel } from '../mocks/helper';
import { MockMemento } from '../mocks/mementos';

suite('Installer E2E command isolation', () => {
    let sandbox: sinon.SinonSandbox;
    let root: string;
    let context: Pick<ExtensionContext, 'globalState' | 'globalStorageUri'>;
    let register: sinon.SinonStub;
    let update: sinon.SinonSpy;
    let getInstaller: sinon.SinonStub;
    let invoke: (provider: unknown, version: unknown) => unknown;
    let previousEnabled: string | undefined;
    let previousRoot: string | undefined;
    const log = createMockLogOutputChannel();

    setup(async () => {
        sandbox = sinon.createSandbox();
        previousEnabled = process.env.VSC_PYTHON_INSTALLER_E2E;
        previousRoot = process.env.VSC_PYTHON_INSTALLER_TEST_ROOT;
        root = await nativeFs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'python-installer-e2e-unit-')));
        await fs.writeFile(path.join(root, '.owned-installer-fixture'), 'python-installer-e2e\n');
        context = {
            globalStorageUri: Uri.file(path.join(root, 'vscode-user', 'User', 'globalStorage')),
            globalState: Object.assign(new MockMemento(), { setKeysForSync: () => undefined }),
        };
        update = sandbox.spy(context.globalState, 'update');
        register = sandbox.stub(commandApis, 'registerCommand').callsFake((_name, callback) => {
            invoke = callback;
            return new Disposable(() => undefined);
        });
        getInstaller = sandbox.stub(installer, 'getPythonInstaller').rejects(new Error('No installer may run in this unit suite'));
        process.env.VSC_PYTHON_INSTALLER_E2E = '1';
        process.env.VSC_PYTHON_INSTALLER_TEST_ROOT = root;
    });

    teardown(async () => {
        sandbox.restore();
        if (previousEnabled === undefined) {
            delete process.env.VSC_PYTHON_INSTALLER_E2E;
        } else {
            process.env.VSC_PYTHON_INSTALLER_E2E = previousEnabled;
        }
        if (previousRoot === undefined) {
            delete process.env.VSC_PYTHON_INSTALLER_TEST_ROOT;
        } else {
            process.env.VSC_PYTHON_INSTALLER_TEST_ROOT = previousRoot;
        }
        await fs.remove(root);
    });

    test('does nothing in an ordinary extension host', async () => {
        delete process.env.VSC_PYTHON_INSTALLER_E2E;

        assert.deepStrictEqual(await registerInstallerTestCommands(context, log), []);

        sinon.assert.notCalled(update);
        sinon.assert.notCalled(register);
        sinon.assert.notCalled(getInstaller);
    });

    test('suppresses automatic prompts before registering the owned fixture command', async () => {
        const commands = await registerInstallerTestCommands(context, log);

        assert.strictEqual(commands.length, 1);
        sinon.assert.calledOnceWithExactly(update, UV_INSTALL_PYTHON_DONT_ASK_KEY, true);
        sinon.assert.calledOnce(register);
        assert.ok(update.calledBefore(register));
        assert.strictEqual(context.globalState.get(UV_INSTALL_PYTHON_DONT_ASK_KEY), true);
        sinon.assert.notCalled(getInstaller);
    });

    test('refuses to change persistent state outside the owned test profile', async () => {
        context = { ...context, globalStorageUri: Uri.file(path.join(path.dirname(root), 'ordinary-user-data')) };

        await assert.rejects(registerInstallerTestCommands(context, log));

        sinon.assert.notCalled(update);
        sinon.assert.notCalled(register);
    });

    test('requires the driver ownership marker before changing persistent state', async () => {
        await fs.writeFile(path.join(root, '.owned-installer-fixture'), 'not-owned\n');

        await assert.rejects(registerInstallerTestCommands(context, log));

        sinon.assert.notCalled(update);
        sinon.assert.notCalled(register);
    });

    test('requires an absolute fixture root', async () => {
        process.env.VSC_PYTHON_INSTALLER_TEST_ROOT = 'relative-fixture';

        await assert.rejects(registerInstallerTestCommands(context, log));

        sinon.assert.notCalled(update);
        sinon.assert.notCalled(register);
    });

    test('rejects unsupported providers and broad version selectors without invoking installers', async () => {
        await registerInstallerTestCommands(context, log);

        await assert.rejects(async () => invoke('unknown', '3.14.7'));
        await assert.rejects(async () => invoke('auto', '3.14'));

        sinon.assert.notCalled(getInstaller);
    });

    test('rechecks fixture ownership when the command is invoked', async () => {
        await registerInstallerTestCommands(context, log);
        await fs.writeFile(path.join(root, '.owned-installer-fixture'), 'not-owned\n');

        await assert.rejects(async () => invoke('auto', '3.14.7'));

        sinon.assert.notCalled(getInstaller);
    });
});
