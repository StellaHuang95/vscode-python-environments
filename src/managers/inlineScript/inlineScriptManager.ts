// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fsapi from 'fs-extra';
import { Disposable, Event, EventEmitter, l10n, LogOutputChannel, MarkdownString, ThemeIcon, Uri } from 'vscode';
import {
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { matchesPythonVersion, readInlineScriptMetadata } from '../../common/inlineScriptMetadata';
import { traceVerbose } from '../../common/logging';
import { normalizePath } from '../../common/utils/pathUtils';
import { setInlineScriptEnvForScript } from './inlineScriptUtils';

/**
 * EnvironmentManager for PEP 723 inline-script envs. Owns the per-script
 * `scriptFsPath → PythonEnvironment` binding (in-memory map + Memento
 * persistence via `inlineScriptUtils`). `create`, `remove`, and
 * `quickCreateConfig` are intentionally omitted; the picker UI hides
 * their entry points until later PRs land them.
 */
export class InlineScriptManager implements EnvironmentManager, Disposable {
    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments: Event<DidChangeEnvironmentsEventArgs> =
        this._onDidChangeEnvironments.event;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment: Event<DidChangeEnvironmentEventArgs> = this._onDidChangeEnvironment.event;

    public readonly name = 'inline-script';
    public readonly displayName = l10n.t('Inline script environments');
    public readonly preferredPackageManagerId = 'ms-python.python:pip';
    public readonly description: string | undefined = undefined;
    public readonly tooltip: string | MarkdownString = new MarkdownString(
        l10n.t('Environments built from PEP 723 inline script metadata.'),
        true,
    );
    public readonly iconPath: IconPath = new ThemeIcon('file-code');

    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();

    constructor(public readonly log: LogOutputChannel) {}

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return;
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        if (scope === 'all') {
            const seen = new Set<string>();
            const unique: PythonEnvironment[] = [];
            for (const env of this.fsPathToEnv.values()) {
                if (!seen.has(env.envId.id)) {
                    seen.add(env.envId.id);
                    unique.push(env);
                }
            }
            return unique;
        }
        if (scope instanceof Uri) {
            const env = await this.getValidBinding(scope);
            return env ? [env] : [];
        }
        return [];
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (!(scope instanceof Uri)) {
            return;
        }
        const normalizedPath = normalizePath(scope.fsPath);
        const before = this.fsPathToEnv.get(normalizedPath);
        if (environment) {
            this.fsPathToEnv.set(normalizedPath, environment);
        } else {
            this.fsPathToEnv.delete(normalizedPath);
        }
        await setInlineScriptEnvForScript(scope.fsPath, environment?.environmentPath.fsPath);
        if (before?.envId.id !== environment?.envId.id) {
            this._onDidChangeEnvironment.fire({ uri: scope, old: before, new: environment });
        }
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (!(scope instanceof Uri)) {
            return undefined;
        }
        return this.getValidBinding(scope);
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    dispose(): void {
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }

    /**
     * Returns the in-memory binding for `scriptUri` if the script's
     * current `requires-python` is still satisfied by the env's version.
     * If the re-verify fails, clears the stale binding (in-memory +
     * Memento) and fires `onDidChangeEnvironment`. The script is
     * re-parsed on every call so post-set edits to the metadata take
     * effect without an explicit refresh.
     */
    private async getValidBinding(scriptUri: Uri): Promise<PythonEnvironment | undefined> {
        const normalizedPath = normalizePath(scriptUri.fsPath);
        const env = this.fsPathToEnv.get(normalizedPath);
        if (!env) {
            return undefined;
        }
        if (await this.requiresPythonStillSatisfied(scriptUri, env)) {
            return env;
        }
        traceVerbose(
            `inline-script env: clearing binding for ${scriptUri.fsPath} — env ${env.version} no longer satisfies requires-python`,
        );
        this.fsPathToEnv.delete(normalizedPath);
        await setInlineScriptEnvForScript(scriptUri.fsPath, undefined);
        this._onDidChangeEnvironment.fire({ uri: scriptUri, old: env, new: undefined });
        return undefined;
    }

    private async requiresPythonStillSatisfied(scriptUri: Uri, env: PythonEnvironment): Promise<boolean> {
        let raw: string;
        try {
            raw = await fsapi.readFile(scriptUri.fsPath, 'utf8');
        } catch {
            return true;
        }
        const metadata = readInlineScriptMetadata(raw);
        if (!metadata?.requiresPython) {
            return true;
        }
        if (!env.version) {
            return true;
        }
        return matchesPythonVersion(metadata.requiresPython, env.version);
    }
}

