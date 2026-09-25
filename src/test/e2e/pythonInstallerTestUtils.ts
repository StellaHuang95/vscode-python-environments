// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { finished } from 'stream/promises';
import { StringDecoder } from 'string_decoder';
import { extensions } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi, PythonProcess } from '../../api';
import { PythonVersion } from '../../common/pythonVersion';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import { ENVS_EXTENSION_ID } from '../constants';
import { waitForApiReady } from '../testUtils';

export interface PersistedInstallerFixture {
    readonly version: string;
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly scriptPythonPath: string;
}

/** Validate the driver's owned temporary root and native configuration before running installer scenarios. */
export async function getInstallerFixtureRoot(): Promise<string> {
    const configuredRoot = process.env.VSC_PYTHON_INSTALLER_TEST_ROOT;
    assert.strictEqual(process.env.VSC_PYTHON_INSTALLER_E2E, '1', 'Use the opt-in installer driver');
    assert.strictEqual(process.platform, 'win32', 'The native installer profile requires Windows');
    assert.ok(configuredRoot && path.isAbsolute(configuredRoot));
    const root = await fs.realpath(configuredRoot);
    assert.ok(isSameOrParentPath(await fs.realpath(os.tmpdir()), root));
    assert.ok(path.basename(root).startsWith('python-installer-e2e-'));
    assert.strictEqual(await fs.readFile(path.join(root, '.owned-installer-fixture'), 'utf8'), 'python-installer-e2e\n');
    assert.strictEqual(
        normalizePath(process.env.PYTHON_MANAGER_CONFIG ?? ''),
        normalizePath(path.join(root, 'pymanager.json')),
        'Native commands must inherit the isolated PyManager configuration',
    );
    const config: unknown = JSON.parse(await fs.readFile(path.join(root, 'pymanager.json'), 'utf8'));
    assert.deepStrictEqual(config, {
        install_dir: path.join(root, 'pim-runtimes'),
        global_dir: path.join(root, 'pim-bin'),
        download_dir: path.join(root, 'pim-downloads'),
        logs_dir: path.join(root, 'pim-logs'),
        install: { disable_shortcut_kinds: 'pep514,start', enable_entrypoints: false },
    });
    return root;
}

/** Read the first host's fixture state, accepting only existing physical paths inside the owned root. */
export async function readInstallerFixture(root: string): Promise<PersistedInstallerFixture> {
    const data: unknown = JSON.parse(await fs.readFile(path.join(root, '.installed-fixture-state.json'), 'utf8'));
    assert.ok(data && typeof data === 'object' && !Array.isArray(data));
    assert.ok('version' in data && typeof data.version === 'string' && PythonVersion.tryParse(data.version));
    assert.ok('pythonPath' in data && typeof data.pythonPath === 'string');
    assert.ok('scriptPath' in data && typeof data.scriptPath === 'string');
    assert.ok('scriptPythonPath' in data && typeof data.scriptPythonPath === 'string');
    for (const value of [data.pythonPath, data.scriptPath, data.scriptPythonPath]) {
        assert.ok(path.isAbsolute(value) && isSameOrParentPath(root, await fs.realpath(value)));
    }
    return {
        version: data.version,
        pythonPath: data.pythonPath,
        scriptPath: data.scriptPath,
        scriptPythonPath: data.scriptPythonPath,
    };
}

/** Activate the real extension and wait for its managers, without requiring an existing Python installation. */
export async function activateInstallerApi(): Promise<PythonEnvironmentApi> {
    const extension = extensions.getExtension<PythonEnvironmentApi>(ENVS_EXTENSION_ID);
    assert.ok(extension, 'Python Environments must be loaded in the real VS Code host');
    const api = await extension.activate();
    const readiness = await waitForApiReady(api, 90_000);
    assert.ok(readiness.ready, readiness.error);
    return api;
}

/**
 * Collect an owned fixture process's output only after both exit and stream completion.
 * @param child The process returned by the extension API.
 * @param timeoutMs Maximum time for exit and output drainage; failure terminates the owned child.
 */
export async function collectPythonOutput(child: PythonProcess, timeoutMs = 30_000): Promise<string> {
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onStdout = (data: Buffer | string) => { stdout += stdoutDecoder.write(Buffer.from(data)); };
    const onStderr = (data: Buffer | string) => { stderr += stderrDecoder.write(Buffer.from(data)); };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.onExit((code, signal) => resolve({ code, signal }));
    });
    const streams = Promise.all([
        finished(child.stdout, { cleanup: true }),
        finished(child.stderr, { cleanup: true }),
    ]);
    try {
        const [{ code, signal }] = await Promise.race([
            Promise.all([exit, streams]),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Python fixture process timed out: ${stderr}`)), timeoutMs);
            }),
        ]);
        completed = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        assert.ok(code === 0 && signal === null, `Python fixture process exited ${code} (${signal}): ${stderr}`);
        return stdout;
    } finally {
        clearTimeout(timer);
        child.stdout.removeListener('data', onStdout);
        child.stderr.removeListener('data', onStderr);
        if (!completed) {
            child.kill();
        }
    }
}

/** Execute Python through the real public API, using the owned fixture workspace as its working directory. */
export async function runFixturePython(
    api: PythonEnvironmentApi,
    root: string,
    environment: PythonEnvironment,
    args: string[],
): Promise<string> {
    const child = await api.runInBackground(environment, { args, cwd: path.join(root, 'workspace') });
    return collectPythonOutput(child);
}
