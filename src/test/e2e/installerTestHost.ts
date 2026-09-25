// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import * as path from 'path';
import Mocha from 'mocha';
import { commands, Disposable, ExtensionContext, version, window } from 'vscode';
import { isSameOrParentPath } from '../../common/utils/pathUtils';
import { getInstallerFixtureRoot } from './pythonInstallerTestUtils';

interface ScenarioResult {
    readonly title: string;
    readonly result: 'passed' | 'failed' | 'pending';
    readonly durationMs?: number;
}

/**
 * Runs only from the temporary fixture extension created by the installer E2E driver.
 * A normal development host is required because --extensionTestsPath disables disk-backed Memento storage.
 */
export function activate(context: ExtensionContext): void {
    const handle = setImmediate(async () => {
        const phase = process.env.VSC_PYTHON_INSTALLER_VERIFY_RELOAD === '1' ? 'reload' : 'install';
        let reportPath: string | undefined;
        let ownedHost = false;
        const failures: { title: string; message: string; stack?: string }[] = [];
        const results: ScenarioResult[] = [];
        try {
            const root = await getInstallerFixtureRoot();
            if (!isSameOrParentPath(root, context.globalStorageUri.fsPath)) {
                throw new Error('The installer test host requires its owned, isolated fixture.');
            }
            ownedHost = true;
            reportPath = path.join(root, `.host-report-${phase}.json`);
            await fs.writeJson(reportPath, { status: 'running' });
            const mocha = new Mocha({ ui: 'tdd', timeout: 300_000, reporter: 'dot', bail: true });
            mocha.addFile(path.join(__dirname, 'pythonInstaller.e2e.test.js'));
            mocha.addFile(path.join(__dirname, 'pymanagerNative.e2e.test.js'));
            const runner = await new Promise<Mocha.Runner>((resolve) => {
                const running = mocha.run(() => resolve(running));
                running.on('pass', (test) => results.push({
                    title: test.fullTitle(), result: 'passed', durationMs: test.duration,
                }));
                running.on('pending', (test) => results.push({ title: test.fullTitle(), result: 'pending' }));
                running.on('fail', (test, error) => {
                    failures.push({ title: test.fullTitle(), message: error.message, stack: error.stack });
                    results.push({ title: test.fullTitle(), result: 'failed', durationMs: test.duration });
                });
            });
            await fs.writeJson(reportPath, {
                status: 'completed',
                passed: runner.stats?.passes ?? 0,
                pending: runner.stats?.pending ?? 0,
                failures,
                results,
                vscodeVersion: version,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (reportPath) {
                await fs.writeJson(reportPath, {
                    status: 'completed',
                    passed: 0,
                    pending: 0,
                    failures: [{ title: 'Installer E2E host', message }],
                    results,
                    vscodeVersion: version,
                });
            } else {
                process.stderr.write(`Installer E2E host: ${message}\n`);
            }
        } finally {
            if (ownedHost) {
                for (const terminal of window.terminals) {
                    terminal.dispose();
                }
                await commands.executeCommand('workbench.action.closeAllEditors');
                await commands.executeCommand('workbench.action.quit');
            }
        }
    });
    context.subscriptions.push(new Disposable(() => clearImmediate(handle)));
}
