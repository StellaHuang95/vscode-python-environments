// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'win32') {
    throw new Error('The PyManager runtime-installation E2E profile requires Windows.');
}
const code = await downloadAndUnzipVSCode('stable');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'python-installer-e2e-')));
const configFile = path.join(root, 'pymanager.json');
let succeeded = false;
try {
    await fs.mkdir(path.join(root, 'workspace'));
    await fs.mkdir(path.join(root, 'workspace', '.vscode'));
    await fs.writeFile(path.join(root, 'workspace', '.vscode', 'settings.json'), JSON.stringify({
        'python-envs.defaultEnvManager': 'ms-python.python:system',
    }));
    await Promise.all(['pim-runtimes', 'pim-bin', 'pim-downloads', 'pim-logs', 'uv-runtimes', 'uv-cache']
        .map((directory) => fs.mkdir(path.join(root, directory))));
    await fs.writeFile(path.join(root, '.owned-installer-fixture'), 'python-installer-e2e\n');
    const userDirectory = path.join(root, 'vscode-user', 'User');
    await fs.mkdir(userDirectory, { recursive: true });
    await fs.writeFile(path.join(userDirectory, 'settings.json'), JSON.stringify({
        'python.useEnvironmentsExtension': true,
        'python-envs.inlineScripts.enabled': true,
        'workbench.startupEditor': 'none',
        'terminal.integrated.defaultProfile.windows': 'PowerShell',
    }));
    const hostExtension = path.join(root, 'vscode-extensions', 'python-envs.installer-e2e-host');
    await fs.mkdir(hostExtension, { recursive: true });
    await fs.writeFile(path.join(hostExtension, 'package.json'), JSON.stringify({
        name: 'installer-e2e-host',
        publisher: 'python-envs',
        version: '0.0.1',
        engines: { vscode: '^1.100.0' },
        activationEvents: ['onStartupFinished'],
        main: './index.cjs',
    }));
    await fs.writeFile(
        path.join(hostExtension, 'index.cjs'),
        `module.exports = require(${JSON.stringify(path.join(repository, 'out', 'test', 'e2e', 'installerTestHost.js'))});\n`,
    );
    await fs.writeFile(configFile, JSON.stringify({
        install_dir: path.join(root, 'pim-runtimes'),
        global_dir: path.join(root, 'pim-bin'),
        download_dir: path.join(root, 'pim-downloads'),
        logs_dir: path.join(root, 'pim-logs'),
        install: { disable_shortcut_kinds: 'pep514,start', enable_entrypoints: false },
    }));
    process.stdout.write(`Installer E2E fixture: ${root}\n`);
    for (const phase of ['install', 'reload']) {
        process.stdout.write(`Installer E2E phase: ${phase}\n`);
        const child = spawn(code, [
            `--extensionDevelopmentPath=${repository}`,
            `--user-data-dir=${path.join(root, 'vscode-user')}`,
            `--extensions-dir=${path.join(root, 'vscode-extensions')}`,
            `--shared-data-dir=${path.join(root, 'vscode-shared')}`,
            '--use-inmemory-secretstorage',
            '--disable-telemetry',
            '--disable-experiments',
            '--disable-workspace-trust',
            '--locale=en',
            path.join(root, 'workspace'),
        ], {
            cwd: repository,
            stdio: 'inherit',
            env: {
                ...process.env,
                VSC_PYTHON_INSTALLER_E2E: '1',
                VSC_PYTHON_E2E_TEST: '1',
                VSC_PYTHON_CI_TEST: '1',
                VSC_PYTHON_INSTALLER_VERIFY_RELOAD: phase === 'reload' ? '1' : '0',
                VSC_PYTHON_INSTALLER_TEST_ROOT: root,
                VSC_PYTHON_TEST_USER_DATA: path.join(root, 'vscode-user'),
                PYTHON_MANAGER_CONFIG: configFile,
                UV_PYTHON_INSTALL_DIR: path.join(root, 'uv-runtimes'),
                UV_CACHE_DIR: path.join(root, 'uv-cache'),
            },
        });
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            process.stderr.write(`Installer E2E ${phase} host exceeded fifteen minutes; retaining its fixture.\n`);
            child.kill();
        }, 15 * 60 * 1000);
        let exitCode;
        try {
            exitCode = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', (exitCode) => resolve(exitCode ?? 1));
            });
        } finally {
            clearTimeout(deadline);
        }
        const report = JSON.parse(await fs.readFile(path.join(root, `.host-report-${phase}.json`), 'utf8'));
        if (
            report.status !== 'completed' ||
            !Array.isArray(report.failures) ||
            !Array.isArray(report.results) ||
            !Number.isInteger(report.passed) ||
            !Number.isInteger(report.pending) ||
            report.results.some((result) =>
                !result || typeof result.title !== 'string' || !['passed', 'failed', 'pending'].includes(result.result))
        ) {
            throw new Error(`The ${phase} host did not report completed tests.`);
        }
        process.stdout.write(`${phase} (VS Code ${report.vscodeVersion}): ${report.passed} passing, ${report.failures.length} failing, ${report.pending} pending\n`);
        for (const result of report.results) {
            process.stdout.write(`  ${result.result}: ${result.title}${result.durationMs === undefined ? '' : ` (${result.durationMs}ms)`}\n`);
        }
        for (const failure of report.failures) {
            process.stderr.write(`${failure.title}\n${failure.stack ?? failure.message}\n`);
        }
        const expectedPasses = phase === 'install' ? 23 : 3;
        const complete =
            report.passed === expectedPasses &&
            report.pending === 0 &&
            report.results.length === expectedPasses &&
            new Set(report.results.map((result) => result.title)).size === expectedPasses &&
            report.results.every((result) => result.result === 'passed');
        process.exitCode = timedOut || exitCode !== 0 || report.failures.length !== 0 || !complete ? 1 : 0;
        if (process.exitCode !== 0) {
            process.stderr.write(`Expected all ${expectedPasses} ${phase} scenarios to pass without skips.\n`);
            break;
        }
        succeeded = phase === 'reload';
    }
} finally {
    if (succeeded) {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } else {
        process.stderr.write(`Retained failed installer fixture for diagnosis: ${root}\n`);
    }
}
