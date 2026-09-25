// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Disposable, ExtensionContext, LogOutputChannel } from 'vscode';
import { registerCommand } from '../common/command.api';
import { PythonVersion } from '../common/pythonVersion';
import { isSameOrParentPath } from '../common/utils/pathUtils';
import { isUvInstalled } from '../managers/builtin/helpers';
import { getPythonInstaller, installApprovedPymanagerRuntime } from '../managers/builtin/pythonInstaller';
import { resolvePymanagerCandidate } from '../managers/builtin/pythonRuntimeCandidates';
import { installPythonWithUv, UV_INSTALL_PYTHON_DONT_ASK_KEY } from '../managers/builtin/uvPythonInstaller';

async function getInstallerFixtureRoot(): Promise<string> {
    const rootValue = process.env.VSC_PYTHON_INSTALLER_TEST_ROOT;
    if (!rootValue || !path.isAbsolute(rootValue)) {
        throw new Error('Installer E2E requires an isolated temporary root.');
    }
    const root = await nativeFs.realpath(rootValue);
    const temporary = await nativeFs.realpath(os.tmpdir());
    if (
        !isSameOrParentPath(temporary, root) ||
        !path.basename(root).startsWith('python-installer-e2e-') ||
        await fs.readFile(path.join(root, '.owned-installer-fixture'), 'utf8') !== 'python-installer-e2e\n'
    ) {
        throw new Error('Refusing an unowned installer E2E location.');
    }
    return root;
}

/**
 * Registers only in the opt-in installer E2E host. The test driver owns the marked temporary
 * root; neither backend can install into the user's normal runtime, alias or registration paths.
 */
export async function registerInstallerTestCommands(
    context: Pick<ExtensionContext, 'globalState' | 'globalStorageUri'>,
    log: LogOutputChannel,
): Promise<Disposable[]> {
    if (process.env.VSC_PYTHON_INSTALLER_E2E !== '1') {
        return [];
    }
    const fixtureRoot = await getInstallerFixtureRoot();
    if (!isSameOrParentPath(fixtureRoot, context.globalStorageUri.fsPath)) {
        throw new Error('Installer E2E requires VS Code user data inside the isolated fixture.');
    }
    // Suppress automatic missing-base prompts only in this owned test profile,
    // before managers initialize. The explicit fixture command supplies the first runtime.
    await context.globalState.update(UV_INSTALL_PYTHON_DONT_ASK_KEY, true);
    return [registerCommand(
        'python-envs.test.installPythonRuntime',
        async (provider: unknown, version: unknown) => {
            if ((provider !== 'auto' && provider !== 'uv') || typeof version !== 'string') {
                throw new Error('Installer E2E requires a provider and concrete Python version.');
            }
            const parsed = PythonVersion.tryParse(version);
            if (!parsed || parsed.major !== 3 || parsed.precision !== 3) {
                throw new Error('Installer E2E requires a concrete Python 3 release.');
            }
            const root = await getInstallerFixtureRoot();
            const configFile = path.join(root, 'pymanager.json');
            await fs.writeJson(configFile, {
                install_dir: path.join(root, 'pim-runtimes'),
                global_dir: path.join(root, 'pim-bin'),
                download_dir: path.join(root, 'pim-downloads'),
                logs_dir: path.join(root, 'pim-logs'),
                install: { disable_shortcut_kinds: 'pep514,start', enable_entrypoints: false },
            });
            let pythonPath: string | undefined;
            let actualProvider: 'pymanager' | 'uv';
            if (provider === 'auto') {
                const selected = await getPythonInstaller(log);
                if (selected.kind !== 'pymanager') {
                    throw new Error('This E2E profile requires an already-installed Python Install Manager.');
                }
                const candidate = await resolvePymanagerCandidate(
                    selected.executable, { version }, log, undefined, configFile,
                );
                if (!candidate) {
                    throw new Error(`The requested E2E Python release is unavailable: ${version}`);
                }
                // The isolated E2E invocation explicitly approves this runtime operation.
                pythonPath = await installApprovedPymanagerRuntime(
                    { ...selected, configFile }, candidate, { version }, log,
                );
                actualProvider = 'pymanager';
            } else {
                if (!(await isUvInstalled(log))) {
                    throw new Error('This E2E profile requires an already-installed uv; it never bootstraps tools.');
                }
                pythonPath = await installPythonWithUv(log, version, {
                    installDirectory: path.join(root, 'uv-runtimes'),
                    installExecutables: false,
                    registerInstallation: false,
                });
                actualProvider = 'uv';
            }
            if (!pythonPath || !isSameOrParentPath(root, await nativeFs.realpath(pythonPath))) {
                throw new Error('The installer did not return an interpreter in the isolated fixture.');
            }
            return { provider: actualProvider, pythonPath };
        },
    )];
}
