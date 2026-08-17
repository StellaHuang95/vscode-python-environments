// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fs from 'fs-extra';
import * as path from 'path';
import { clean as cleanPep440, satisfies as satisfiesPep440 } from '@renovatebot/pep440';
import { Disposable, Event, EventEmitter, l10n, LogOutputChannel, MarkdownString, ThemeIcon, Uri } from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../../api';
import { getErrorMessage } from '../../../common/errors/utils';
import { computeCacheKey, normalizeDependency } from '../../../common/inlineScript/cacheKey';
import {
    CacheEnvironmentInspection,
    InlineScriptEnvMeta,
    hashSourceMetadataIdentity,
    mergeSourceMetadataIdentityHashes,
    META_SCHEMA_VERSION,
    getBaseInterpreterStatus,
    getScriptEnvCacheRoot,
    getScriptEnvDir,
    inspectOwnedCacheEntry,
    inspectMetaJson,
    resolveCacheEntryPath,
    writeMetaJson,
} from '../../../common/inlineScript/cacheLayout';
import { extractLowerBoundVersion, pickCompatibleInterpreter } from '../../../common/inlineScript/interpreter';
import { InlineScriptMetadata, readInlineScriptMetadataFromFile } from '../../../common/inlineScript/metadata';
import {
    getInlineScriptMetadataRoutingIdentity,
    InlineScriptMetadataChangeEvent,
    InlineScriptRoutingRegistry,
} from '../../../common/inlineScript/routingRegistry';
import {
    CONDA_MANAGER_ID,
    ENVS_EXTENSION_ID,
    INLINE_SCRIPT_MANAGER_ID,
    PYENV_MANAGER_ID,
    SYSTEM_MANAGER_ID,
} from '../../../common/constants';
import { acquireFileLock, AcquiredFileLock } from '../../../common/lockfile.apis';
import { getWorkspacePersistentState, PersistentState } from '../../../common/persistentState';
import { isFileNotFoundError } from '../../../common/utils/filesystem';
import { normalizePath } from '../../../common/utils/pathUtils';
import { compareReleaseSegments, parseReleaseSegments } from '../../../common/utils/pep440Release';
import { getVenvPythonPath } from '../../../common/utils/virtualEnvironment';
import { getOpenTextDocuments, onDidDeleteFiles, onDidRenameFiles } from '../../../common/workspace.apis';
import { NativePythonFinder } from '../../common/nativePythonFinder';
import { resolveSystemPythonEnvironmentPath } from '../utils';
import * as uvPythonInstaller from '../uvPythonInstaller';
import { createWithProgress, resolveVenvPythonEnvironmentPath } from '../venvUtils';

const BASE_INTERPRETER_MANAGER_IDS = new Set([
    SYSTEM_MANAGER_ID,
    CONDA_MANAGER_ID,
    PYENV_MANAGER_ID,
]);

const CACHE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const CACHE_LOCK_RETRY_MS = 500;
const CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS = 5_000;
/** Workspace-state key for PEP 723 script path to environment executable associations. */
export const INLINE_SCRIPT_ENVS_KEY = `${ENVS_EXTENSION_ID}:inline-script:SCRIPT_ENVIRONMENTS`;
const PERSISTED_ASSOCIATION_SCHEMA_VERSION = 1 as const;

interface SelectedBaseInterpreter {
    readonly environment: PythonEnvironment;
    readonly canonicalPath: string;
}

interface CreateOrReuseEnvironmentOptions {
    readonly cacheKey: string;
    readonly packages: ReadonlyArray<string>;
    readonly metadata: InlineScriptMetadata;
    readonly selectedBase: SelectedBaseInterpreter;
    readonly pendingCreation: PendingCreationContext;
}

interface BuildCacheEntryResult {
    readonly environment?: PythonEnvironment;
    readonly retainLock?: boolean;
}

interface PendingCreationContext {
    promise: Promise<PythonEnvironment | undefined>;
    sourceMetadataIdentityHashes?: readonly string[];
    hasStartedRecordingSourceMetadataIdentityHashes: boolean;
    recordedSourceMetadataIdentityHashes?: readonly string[];
}

interface MergeCacheEntrySourceMetadataIdentityHashResult {
    readonly success: boolean;
    readonly sourceMetadataIdentityHashes?: readonly string[];
}

type CacheEntryInspection =
    | { readonly kind: 'absent' | 'stale' | 'uncertain' }
    | { readonly kind: 'reusable'; readonly environment: PythonEnvironment };

interface PendingAssociationValidation {
    readonly metadataIdentity: string;
    readonly associationRevision: number;
    readonly promise: Promise<PythonEnvironment | undefined>;
}

interface PendingMetadataRefresh {
    readonly metadataIdentity: string;
    readonly metadataRevision: number;
    readonly associationRevision: number;
    readonly promise: Promise<void>;
}

interface ParsedPersistedAssociations {
    readonly rawEntries: Record<string, unknown>;
    readonly records: PersistedInlineScriptEnvironments;
    readonly invalidKeys: Set<string>;
}

interface SavedMetadataSnapshot {
    readonly metadata?: InlineScriptMetadata;
    readonly identity?: string;
}

/** Manages extension-owned PEP 723 script environments. */
export class InlineScriptEnvManager implements EnvironmentManager, Disposable {
    private readonly pendingSetups = new Map<string, Promise<PythonEnvironment | undefined>>();
    private readonly pendingCreations = new Map<string, PendingCreationContext>();
    private readonly directlyResolvedBaseInterpreters = new Map<string, PythonEnvironment>();
    private baseInterpreterInstallationQueue: Promise<void> = Promise.resolve();
    private readonly pendingRehydrations = new Map<string, PendingAssociationValidation>();
    private readonly pendingMetadataRefreshes = new Map<string, PendingMetadataRefresh>();
    private readonly fsPathToEnv = new Map<string, PythonEnvironment>();
    private readonly fsPathToPersistedAssociation = new Map<string, PersistedAssociationRecord>();
    private readonly cachedAssociationValidatedAt = new Map<string, number>();
    private readonly lastValidatedMetadataIdentities = new Map<string, string>();
    private readonly lastValidatedMetadataIdentityProofs = new Map<string, boolean>();
    private readonly associationRevisions = new Map<string, number>();
    private readonly subscriptions: Disposable[] = [];
    private persistenceQueue: Promise<void> = Promise.resolve();
    private selectionQueue: Promise<void> = Promise.resolve();

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

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        private readonly baseManager: EnvironmentManager,
        private readonly globalStorageUri: Uri,
        public readonly log: LogOutputChannel,
        private readonly routingRegistry: InlineScriptRoutingRegistry = new InlineScriptRoutingRegistry(),
    ) {
        this.subscriptions.push(
            this.routingRegistry.onDidChangeMetadata((event) => {
                void this.handleSavedMetadataChange(event).catch((error) => {
                    this.log.warn(`Failed to refresh inline-script routing state: ${getErrorMessage(error)}`);
                });
            }),
            onDidDeleteFiles((event) => {
                void this.clearAssociationsForScripts(event.files).catch((error) => {
                    this.log.warn(`Failed to clear inline-script associations for deleted files: ${getErrorMessage(error)}`);
                });
            }),
            onDidRenameFiles((event) => {
                void this.clearAssociationsForScripts(event.files.map((file) => file.oldUri)).catch((error) => {
                    this.log.warn(`Failed to clear inline-script associations for renamed files: ${getErrorMessage(error)}`);
                });
            }),
        );
        queueMicrotask(() => {
            void this.initializePersistedAssociations().catch((error) => {
                this.log.warn(
                    `Failed to prime inline-script environment associations: ${getErrorMessage(error)}`,
                );
            });
        });
    }

    async create(
        scope: CreateEnvironmentScope,
        options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        try {
            const scriptUri = this.getScriptUri(scope);
            if (!scriptUri) {
                this.log.warn('Inline-script environment creation requires exactly one local file URI.');
                return undefined;
            }

            const metadata = await readInlineScriptMetadataFromFile(scriptUri);
            if (!metadata) {
                this.log.warn(`No valid PEP 723 metadata found in ${scriptUri.fsPath}.`);
                return undefined;
            }

            const packages = [
                ...(metadata.dependencies ?? []),
                ...(options?.additionalPackages ?? []),
            ].map((value) => value.trim());
            if (packages.some((value) => value.length === 0)) {
                this.log.warn(`Inline-script dependencies must not contain empty entries: ${scriptUri.fsPath}.`);
                return undefined;
            }

            const setupKey = this.getPendingSetupKey(scriptUri, metadata, packages, options);
            const pending = this.pendingSetups.get(setupKey);
            if (pending) {
                return await pending;
            }

            const setup = this.createForScript(scriptUri, metadata, packages, options);
            this.pendingSetups.set(setupKey, setup);
            try {
                return await setup;
            } finally {
                if (this.pendingSetups.get(setupKey) === setup) {
                    this.pendingSetups.delete(setupKey);
                }
            }
        } catch (error) {
            this.log.error(`Failed to set up inline-script environment: ${getErrorMessage(error)}`);
            return undefined;
        }
    }

    private async createForScript(
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
        packages: readonly string[],
        options?: CreateEnvironmentOptions,
    ): Promise<PythonEnvironment | undefined> {
        let selectedBase = await this.selectBaseInterpreter(metadata);
        if (!selectedBase && options?.quickCreate !== true) {
            selectedBase = await this.installAndSelectBaseInterpreter(metadata);
        }
        if (!selectedBase) {
            this.log.warn(`No compatible Python is available for inline-script environment creation: ${scriptUri.fsPath}.`);
            return undefined;
        }

        const cacheKey = computeCacheKey({
            dependencies: packages,
            interpreterPath: selectedBase.canonicalPath,
        });
        const metadataIdentity = getInlineScriptMetadataRoutingIdentity(metadata);
        const sourceMetadataIdentityHash = metadataIdentity ? hashSourceMetadataIdentity(metadataIdentity) : undefined;
        const pending = this.pendingCreations.get(cacheKey);
        if (pending) {
            const joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes =
                pending.hasStartedRecordingSourceMetadataIdentityHashes;
            this.addPendingCreationSourceMetadataIdentityHash(pending, sourceMetadataIdentityHash);
            const environment = await pending.promise;
            return await this.finalizeCreateForScript(
                cacheKey,
                environment,
                sourceMetadataIdentityHash,
                pending,
                joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes,
            );
        }
        const pendingCreation: PendingCreationContext = {
            promise: Promise.resolve(undefined),
            sourceMetadataIdentityHashes: mergeSourceMetadataIdentityHashes(undefined, sourceMetadataIdentityHash),
            hasStartedRecordingSourceMetadataIdentityHashes: false,
        };
        const creation = this.createOrReuseEnvironment({
            cacheKey,
            packages,
            metadata,
            selectedBase,
            pendingCreation,
        });
        pendingCreation.promise = creation;
        this.pendingCreations.set(cacheKey, pendingCreation);
        try {
            const environment = await creation;
            return await this.finalizeCreateForScript(
                cacheKey,
                environment,
                sourceMetadataIdentityHash,
                pendingCreation,
                false,
            );
        } finally {
            if (this.pendingCreations.get(cacheKey) === pendingCreation) {
                this.pendingCreations.delete(cacheKey);
            }
        }
    }

    private getPendingSetupKey(
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
        packages: readonly string[],
        options: CreateEnvironmentOptions | undefined,
    ): string {
        const normalizedPackages = Array.from(new Set(packages.map(normalizeDependency))).sort();
        return JSON.stringify([
            normalizePath(scriptUri.fsPath),
            metadata.requiresPython?.trim() ?? '',
            options?.quickCreate === true ? 'quick' : 'interactive',
            normalizedPackages,
        ]);
    }

    private addPendingCreationSourceMetadataIdentityHash(
        pendingCreation: PendingCreationContext,
        sourceMetadataIdentityHash: string | undefined,
    ): void {
        pendingCreation.sourceMetadataIdentityHashes = mergeSourceMetadataIdentityHashes(
            pendingCreation.sourceMetadataIdentityHashes,
            sourceMetadataIdentityHash,
        );
    }

    private async finalizeCreateForScript(
        cacheKey: string,
        environment: PythonEnvironment | undefined,
        sourceMetadataIdentityHash: string | undefined,
        pendingCreation: PendingCreationContext,
        joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes: boolean,
    ): Promise<PythonEnvironment | undefined> {
        if (!environment || !sourceMetadataIdentityHash) {
            return environment;
        }
        if (
            pendingCreation.recordedSourceMetadataIdentityHashes?.includes(sourceMetadataIdentityHash) !== true &&
            joinedAfterPendingCreationStartedRecordingSourceMetadataIdentityHashes
        ) {
            const mergeResult = await this.mergeCacheEntrySourceMetadataIdentityHash(
                cacheKey,
                sourceMetadataIdentityHash,
            );
            if (!mergeResult.success) {
                this.log.warn(
                    `Failed to durably record inline-script cache provenance for ${cacheKey}; returning no environment to the caller.`,
                );
                return undefined;
            }
            pendingCreation.recordedSourceMetadataIdentityHashes = mergeResult.sourceMetadataIdentityHashes;
        }
        return environment;
    }

    async refresh(_scope: RefreshEnvironmentsScope): Promise<void> {
        return;
    }

    async getEnvironments(_scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        return [];
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        return this.enqueueSelection(() => this.setInternal(scope, environment));
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        return this.getInternal(scope);
    }

    async resolve(_context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        return undefined;
    }

    private getScriptUri(scope: CreateEnvironmentScope): Uri | undefined {
        const uri = scope instanceof Uri ? scope : Array.isArray(scope) && scope.length === 1 ? scope[0] : undefined;
        return uri?.scheme === 'file' ? uri : undefined;
    }

    private async setInternal(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        const scripts = this.getScriptUris(scope);
        if (scripts.length === 0) {
            return;
        }

        let environmentPath: string | undefined;
        if (environment) {
            const ownership = await this.inspectAssociationOwnership(environment);
            if (ownership !== 'expected') {
                const message = `Inline-script environment is not an owned cache entry: ${environment.environmentPath.fsPath}.`;
                this.log.warn(message);
                throw new Error(message);
            }
            environmentPath = environment.environmentPath.fsPath;
        }

        const updates: PendingScriptUpdate[] = [];
        for (const script of scripts) {
            const before = await this.getAssociationForMutation(script.scriptPath);
            const persistedAssociation = this.getPersistedAssociationFromMemory(script.scriptPath);
            const savedMetadata = environment ? await this.getSavedMetadataForPersistence(script.uri) : undefined;
            const sourceMetadataIdentity =
                environment && savedMetadata
                    ? await this.resolveVerifiedSourceMetadataIdentity(script, environment, savedMetadata)
                    : undefined;
            const nextPersistedAssociation = environmentPath
                ? this.createPersistedAssociationRecord(environmentPath, sourceMetadataIdentity, savedMetadata?.identity)
                : undefined;
            const needsPersistence = nextPersistedAssociation
                ? !this.isSamePersistedAssociation(persistedAssociation, nextPersistedAssociation)
                : persistedAssociation !== undefined;
            const shouldNotify =
                (!this.isSameEnvironment(before, environment) &&
                    !this.isSamePersistedAssociation(persistedAssociation, nextPersistedAssociation)) ||
                (!environment && persistedAssociation !== undefined);
            const hasPendingRehydration = this.pendingRehydrations.has(script.scriptPath);
            const cached = this.fsPathToEnv.get(script.scriptPath);
            const needsMemoryUpdate = environment ? cached !== environment : cached !== undefined;
            if (needsPersistence || shouldNotify || hasPendingRehydration || needsMemoryUpdate) {
                updates.push({
                    ...script,
                    before,
                    persistedAssociation: nextPersistedAssociation,
                    needsPersistence,
                    shouldNotify,
                });
            }
        }
        if (updates.length === 0) {
            return;
        }

        try {
            const persistenceUpdates = updates.filter((update) => update.needsPersistence);
            if (persistenceUpdates.length > 0) {
                await this.updatePersistedAssociations(
                    persistenceUpdates.map((update) => ({
                        scriptPath: update.scriptPath,
                        persistedAssociation: update.persistedAssociation,
                    })),
                );
            }
        } catch (error) {
            this.log.error(`Failed to persist inline-script environment association: ${getErrorMessage(error)}`);
            throw error;
        }

        for (const update of updates) {
            this.bumpAssociationRevision(update.scriptPath);
            this.pendingRehydrations.delete(update.scriptPath);
            this.pendingMetadataRefreshes.delete(update.scriptPath);
            if (environment) {
                this.fsPathToEnv.set(update.scriptPath, environment);
                this.fsPathToPersistedAssociation.set(update.scriptPath, update.persistedAssociation!);
                this.invalidateCachedAssociationValidation(update.scriptPath);
            } else {
                this.fsPathToEnv.delete(update.scriptPath);
                this.fsPathToPersistedAssociation.delete(update.scriptPath);
                this.invalidateCachedAssociationValidation(update.scriptPath);
            }
            if (update.shouldNotify) {
                this._onDidChangeEnvironment.fire({
                    uri: update.uri,
                    old: update.before,
                    new: environment,
                });
            }
        }

        await Promise.all(
            updates.map(async (update) => {
                if (!environment) {
                    this.clearValidatedRouteableState(update.uri);
                    return;
                }
                await this.updateValidatedStateForSelection(update);
            }),
        );
    }

    private async getInternal(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        if (!(scope instanceof Uri) || scope.scheme !== 'file') {
            return undefined;
        }

        // An unreadable or invalid metadata block is indistinguishable from a transient
        // read failure, so retain the association but do not return it.
        const metadata = await readInlineScriptMetadataFromFile(scope);
        if (!metadata) {
            return undefined;
        }

        return this.getAssociationForMetadata(
            normalizePath(scope.fsPath),
            scope,
            metadata,
        );
    }

    private getScriptUris(scope: SetEnvironmentScope): ScriptReference[] {
        const candidates = scope instanceof Uri ? [scope] : Array.isArray(scope) ? scope : undefined;
        if (
            !candidates ||
            candidates.length === 0 ||
            candidates.some((candidate) => !(candidate instanceof Uri) || candidate.scheme !== 'file')
        ) {
            throw new Error('Inline-script environment selection requires one or more local file URIs.');
        }

        const scripts: ScriptReference[] = [];
        const seen = new Set<string>();
        for (const candidate of candidates) {
            const scriptPath = normalizePath(candidate.fsPath);
            if (!seen.has(scriptPath)) {
                seen.add(scriptPath);
                scripts.push({ uri: candidate, scriptPath });
            }
        }
        return scripts;
    }

    private async getAssociationForMetadata(
        scriptPath: string,
        scriptUri: Uri,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        const pending = this.pendingRehydrations.get(scriptPath);
        const cached = this.fsPathToEnv.get(scriptPath);
        const revision = this.associationRevisions.get(scriptPath) ?? 0;
        const metadataIdentity = getInlineScriptMetadataRoutingIdentity(metadata)!;
        const forceFreshValidation =
            this.fsPathToPersistedAssociation.get(scriptPath)?.metadataBinding.kind === 'pending';
        if (
            pending &&
            pending.metadataIdentity === metadataIdentity &&
            pending.associationRevision === revision
        ) {
            return pending.promise;
        }
        if (cached) {
            const validatedAt = this.cachedAssociationValidatedAt.get(scriptPath);
            if (
                !forceFreshValidation &&
                validatedAt !== undefined &&
                this.lastValidatedMetadataIdentities.get(scriptPath) === metadataIdentity &&
                Date.now() - validatedAt < CACHED_ASSOCIATION_VALIDATION_INTERVAL_MS
            ) {
                return cached;
            }
            const validation = this.validateCachedAssociation(
                scriptPath,
                scriptUri,
                cached,
                revision,
                metadataIdentity,
                metadata,
            );
            this.pendingRehydrations.set(scriptPath, {
                metadataIdentity,
                associationRevision: revision,
                promise: validation,
            });
            try {
                return await validation;
            } finally {
                if (this.pendingRehydrations.get(scriptPath)?.promise === validation) {
                    this.pendingRehydrations.delete(scriptPath);
                }
            }
        }

        const rehydration = this.rehydrateAssociation(
            scriptPath,
            scriptUri,
            revision,
            metadataIdentity,
            metadata,
        );
        this.pendingRehydrations.set(scriptPath, {
            metadataIdentity,
            associationRevision: revision,
            promise: rehydration,
        });
        try {
            return await rehydration;
        } finally {
            if (this.pendingRehydrations.get(scriptPath)?.promise === rehydration) {
                this.pendingRehydrations.delete(scriptPath);
            }
        }
    }

    private async getAssociationForMutation(scriptPath: string): Promise<PythonEnvironment | undefined> {
        const cached = this.fsPathToEnv.get(scriptPath);
        if (cached) {
            return cached;
        }
        await this.getPersistedAssociation(scriptPath);
        return this.fsPathToEnv.get(scriptPath);
    }

    private async validateCachedAssociation(
        scriptPath: string,
        scriptUri: Uri,
        cached: PythonEnvironment,
        revision: number,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        const environmentPath = cached.environmentPath.fsPath;
        const expectedPersistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
        const envDirPath = path.dirname(path.dirname(environmentPath));
        const busy = await this.isCacheEntryBusy(envDirPath);
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (busy) {
            return undefined;
        }
        try {
            const stat = await fs.stat(environmentPath);
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (stat.isFile()) {
                const resolved = await resolveVenvPythonEnvironmentPath(
                    environmentPath,
                    this.nativeFinder,
                    this.api,
                    this,
                    this.baseManager,
                );
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (!resolved) {
                    return undefined;
                }
                const ownership = await this.inspectAssociationOwnership(resolved);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (ownership === 'stale') {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        expectedPersistedAssociation,
                    );
                    return undefined;
                }
                if (ownership !== 'expected') {
                    return undefined;
                }
                const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (metadataMatch === 'mismatched') {
                    return undefined;
                }
                const metadataIdentityProven = await this.currentCacheEntryProvesSourceMetadataIdentity(
                    resolved,
                    metadataIdentity,
                    metadata,
                );
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                const current = this.fsPathToEnv.get(scriptPath);
                this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
                this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
                this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
                if (current && this.isSameEnvironment(current, resolved)) {
                    return current;
                }
                if (cached.version === resolved.version) {
                    return cached;
                }
                this.fsPathToEnv.set(scriptPath, resolved);
                this._onDidChangeEnvironment.fire({ uri: scriptUri, old: cached, new: resolved });
                return resolved;
            }
            const becameBusy = await this.isCacheEntryBusy(envDirPath);
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (!becameBusy) {
                await this.removeStalePersistedAssociation(
                    scriptPath,
                    environmentPath,
                    revision,
                    scriptUri,
                    expectedPersistedAssociation,
                );
            }
        } catch (error) {
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return this.fsPathToEnv.get(scriptPath);
            }
            if (this.isDefinitivelyStalePathError(error)) {
                const becameBusy = await this.isCacheEntryBusy(envDirPath);
                if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                    return this.fsPathToEnv.get(scriptPath);
                }
                if (!becameBusy) {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        expectedPersistedAssociation,
                    );
                }
            } else {
                this.log.warn(
                    `Unable to inspect cached inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
                );
            }
        }
        return undefined;
    }

    private async rehydrateAssociation(
        scriptPath: string,
        scriptUri: Uri,
        revision: number,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<PythonEnvironment | undefined> {
        let persistedAssociation: PersistedAssociationRecord | undefined;
        try {
            persistedAssociation = await this.getPersistedAssociation(scriptPath);
        } catch (error) {
            this.log.warn(`Failed to read inline-script environment association: ${getErrorMessage(error)}`);
            return undefined;
        }
        const environmentPath = persistedAssociation?.environmentPath;
        if (!environmentPath) {
            return undefined;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        if (!path.isAbsolute(environmentPath)) {
            await this.removeStalePersistedAssociation(
                scriptPath,
                environmentPath,
                revision,
                scriptUri,
                persistedAssociation,
            );
            return undefined;
        }
        const envDirPath = path.dirname(path.dirname(environmentPath));
        if (await this.isCacheEntryBusy(envDirPath)) {
            return undefined;
        }

        try {
            const stat = await fs.stat(environmentPath);
            if (!stat.isFile()) {
                if (!(await this.isCacheEntryBusy(envDirPath))) {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        persistedAssociation,
                    );
                }
                return undefined;
            }
        } catch (error) {
            if (this.isDefinitivelyStalePathError(error)) {
                if (!(await this.isCacheEntryBusy(envDirPath))) {
                    await this.removeStalePersistedAssociation(
                        scriptPath,
                        environmentPath,
                        revision,
                        scriptUri,
                        persistedAssociation,
                    );
                }
            } else {
                this.log.warn(
                    `Unable to inspect persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
                );
            }
            return undefined;
        }

        let resolved: PythonEnvironment | undefined;
        try {
            resolved = await resolveVenvPythonEnvironmentPath(
                environmentPath,
                this.nativeFinder,
                this.api,
                this,
                this.baseManager,
            );
        } catch (error) {
            this.log.warn(
                `Unable to resolve persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
            );
            return undefined;
        }
        if (!resolved) {
            // PET/API resolution can fail transiently. Keep the association for a later retry.
            return undefined;
        }

        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        let ownership: CacheEnvironmentInspection;
        try {
            ownership = await this.inspectAssociationOwnership(resolved);
        } catch (error) {
            this.log.warn(
                `Unable to inspect persisted inline-script environment ${environmentPath}: ${getErrorMessage(error)}`,
            );
            return undefined;
        }
        if (ownership === 'stale') {
            await this.removeStalePersistedAssociation(
                scriptPath,
                environmentPath,
                revision,
                scriptUri,
                persistedAssociation,
            );
            return undefined;
        }
        if (ownership !== 'expected') {
            return undefined;
        }
        const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
        if (metadataMatch === 'mismatched') {
            return undefined;
        }
        const metadataIdentityProven = await this.currentCacheEntryProvesSourceMetadataIdentity(
            resolved,
            metadataIdentity,
            metadata,
        );
        if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
            return this.fsPathToEnv.get(scriptPath);
        }

        const current = this.fsPathToEnv.get(scriptPath);
        this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
        this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
        this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
        if (current && this.isSameEnvironment(current, resolved)) {
            return current;
        }
        if (!this.isCurrentAssociationRevision(scriptPath, revision) || this.fsPathToEnv.has(scriptPath)) {
            return this.fsPathToEnv.get(scriptPath);
        }
        this.fsPathToEnv.set(scriptPath, resolved);
        this._onDidChangeEnvironment.fire({ uri: scriptUri, old: undefined, new: resolved });
        return resolved;
    }

    private inspectAssociationMetadata(
        scriptPath: string,
        metadataIdentity: string,
        allowUnboundAssociation: boolean,
    ): 'matched' | 'pending' | 'legacy' | 'mismatched' {
        const persistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
        if (!persistedAssociation) {
            return 'mismatched';
        }
        if (persistedAssociation.metadataBinding.kind === 'matched') {
            return persistedAssociation.metadataBinding.sourceIdentity === metadataIdentity ? 'matched' : 'mismatched';
        }
        if (persistedAssociation.metadataBinding.kind === 'pending') {
            return persistedAssociation.metadataBinding.sourceIdentity === metadataIdentity && allowUnboundAssociation
                ? 'pending'
                : 'mismatched';
        }
        return allowUnboundAssociation ? 'legacy' : 'mismatched';
    }

    private async inspectAssociationOwnership(environment: PythonEnvironment): Promise<CacheEnvironmentInspection> {
        if (environment.envId.managerId !== INLINE_SCRIPT_MANAGER_ID || !path.isAbsolute(environment.sysPrefix)) {
            return 'uncertain';
        }
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const envDir = Uri.file(environment.sysPrefix);
        try {
            if (!(await resolveCacheEntryPath(cacheRoot, envDir))) {
                return 'stale';
            }
        } catch {
            return 'uncertain';
        }
        return inspectOwnedCacheEntry(
            environment,
            cacheRoot,
            envDir,
        );
    }

    private async handleSavedMetadataChange(event: InlineScriptMetadataChangeEvent): Promise<void> {
        if (event.metadata === undefined) {
            this.clearValidatedRouteableState(event.uri);
            return;
        }
        await this.refreshValidatedAssociationForMetadata(
            event.uri,
            event.metadata,
            event.metadataIdentity ?? getInlineScriptMetadataRoutingIdentity(event.metadata)!,
            event.metadataRevision,
        );
    }

    private async refreshValidatedAssociationForMetadata(
        uri: Uri,
        metadata: InlineScriptMetadata,
        metadataIdentity: string,
        metadataRevision: number,
    ): Promise<void> {
        const scriptPath = normalizePath(uri.fsPath);
        const associationRevision = this.associationRevisions.get(scriptPath) ?? 0;
        const pendingRefresh = this.pendingMetadataRefreshes.get(scriptPath);
        if (
            pendingRefresh &&
            pendingRefresh.metadataIdentity === metadataIdentity &&
            pendingRefresh.metadataRevision === metadataRevision &&
            pendingRefresh.associationRevision === associationRevision
        ) {
            return pendingRefresh.promise;
        }
        const refresh = this.refreshValidatedAssociationForMetadataInternal(
            scriptPath,
            uri,
            metadata,
            metadataIdentity,
            metadataRevision,
            associationRevision,
        );
        this.pendingMetadataRefreshes.set(scriptPath, {
            metadataIdentity,
            metadataRevision,
            associationRevision,
            promise: refresh,
        });
        try {
            await refresh;
        } finally {
            if (this.pendingMetadataRefreshes.get(scriptPath)?.promise === refresh) {
                this.pendingMetadataRefreshes.delete(scriptPath);
            }
        }
    }

    private async refreshValidatedAssociationForMetadataInternal(
        scriptPath: string,
        uri: Uri,
        metadata: InlineScriptMetadata,
        metadataIdentity: string,
        metadataRevision: number,
        associationRevision: number,
    ): Promise<void> {
        const environment = await this.getAssociationForMetadata(scriptPath, uri, metadata);
        if (!this.isCurrentMetadataRefreshTask(uri, metadataIdentity, metadataRevision, scriptPath, associationRevision)) {
            return;
        }
        if (!environment) {
            this.clearValidatedRouteableState(uri);
            return;
        }
        let metadataIdentityProven = this.lastValidatedMetadataIdentityProofs.get(scriptPath);
        if (
            this.lastValidatedMetadataIdentities.get(scriptPath) !== metadataIdentity ||
            metadataIdentityProven === undefined
        ) {
            metadataIdentityProven = await this.currentCacheEntryProvesSourceMetadataIdentity(
                environment,
                metadataIdentity,
                metadata,
            );
            if (
                !this.isCurrentMetadataRefreshTask(
                    uri,
                    metadataIdentity,
                    metadataRevision,
                    scriptPath,
                    associationRevision,
                )
            ) {
                return;
            }
            this.cachedAssociationValidatedAt.set(scriptPath, Date.now());
            this.lastValidatedMetadataIdentities.set(scriptPath, metadataIdentity);
            this.lastValidatedMetadataIdentityProofs.set(scriptPath, metadataIdentityProven);
        }
        if (metadataIdentityProven !== true) {
            this.clearValidatedRouteableState(uri);
            return;
        }
        const metadataMatch = this.inspectAssociationMetadata(scriptPath, metadataIdentity, true);
        if (metadataMatch === 'pending') {
            let bindResult = await this.bindPendingMetadataIdentity(
                scriptPath,
                environment.environmentPath.fsPath,
                metadataIdentity,
                metadataRevision,
                associationRevision,
                uri,
            );
            if (!this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)) {
                return;
            }
            if (
                bindResult === 'stale' &&
                !this.isCurrentAssociationRevision(scriptPath, associationRevision)
            ) {
                const currentAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
                const currentAssociationRevision = this.associationRevisions.get(scriptPath) ?? 0;
                if (
                    currentAssociation?.metadataBinding.kind === 'pending' &&
                    currentAssociation.metadataBinding.sourceIdentity === metadataIdentity &&
                    normalizePath(currentAssociation.environmentPath) ===
                        normalizePath(environment.environmentPath.fsPath)
                ) {
                    bindResult = await this.bindPendingMetadataIdentity(
                        scriptPath,
                        environment.environmentPath.fsPath,
                        metadataIdentity,
                        metadataRevision,
                        currentAssociationRevision,
                        uri,
                    );
                    if (
                        !this.isCurrentMetadataRefreshTask(
                            uri,
                            metadataIdentity,
                            metadataRevision,
                            scriptPath,
                            currentAssociationRevision,
                        )
                    ) {
                        return;
                    }
                }
            } else if (!this.isCurrentAssociationRevision(scriptPath, associationRevision)) {
                return;
            }
            if (bindResult !== 'bound') {
                const currentAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
                if (
                    currentAssociation?.metadataBinding.kind === 'pending' &&
                    currentAssociation.metadataBinding.sourceIdentity === metadataIdentity &&
                    normalizePath(currentAssociation.environmentPath) ===
                        normalizePath(environment.environmentPath.fsPath)
                ) {
                    this.invalidateCachedAssociationValidation(scriptPath);
                }
                return;
            }
        } else if (metadataMatch !== 'matched') {
            this.clearValidatedRouteableState(uri);
            return;
        }
        this.routingRegistry.setValidatedAssociation(uri, true);
    }

    private async updateValidatedStateForSelection(script: ScriptReference): Promise<void> {
        const savedMetadata = await this.getSavedMetadataForPersistence(script.uri);
        if (!savedMetadata.identity) {
            this.clearValidatedRouteableState(script.uri);
            return;
        }
        if (this.inspectAssociationMetadata(script.scriptPath, savedMetadata.identity, false) !== 'matched') {
            this.clearValidatedRouteableState(script.uri);
            return;
        }
        this.cachedAssociationValidatedAt.set(script.scriptPath, Date.now());
        this.lastValidatedMetadataIdentities.set(script.scriptPath, savedMetadata.identity);
        this.routingRegistry.setValidatedAssociation(
            script.uri,
            this.routingRegistry.getMetadataIdentity(script.uri) === savedMetadata.identity,
        );
    }

    private async getSavedMetadataForPersistence(uri: Uri): Promise<SavedMetadataSnapshot> {
        for (const document of getOpenTextDocuments()) {
            if (document.uri.toString() === uri.toString() && document.isDirty) {
                return {};
            }
        }
        return this.readSavedMetadataSnapshot(uri);
    }

    private async readSavedMetadataSnapshot(uri: Uri): Promise<SavedMetadataSnapshot> {
        const metadata = await readInlineScriptMetadataFromFile(uri);
        return {
            metadata,
            identity: getInlineScriptMetadataRoutingIdentity(metadata),
        };
    }

    private async currentCacheEntryProvesSourceMetadataIdentity(
        environment: PythonEnvironment,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): Promise<boolean> {
        const sidecar = await this.readCurrentCacheEntrySidecar(environment);
        return !!sidecar && this.cacheEntryProvesSourceMetadataIdentity(sidecar, environment, metadataIdentity, metadata);
    }

    private async readCurrentCacheEntrySidecar(environment: PythonEnvironment): Promise<InlineScriptEnvMeta | undefined> {
        let sidecarResult;
        try {
            sidecarResult = await inspectMetaJson(Uri.file(environment.sysPrefix));
        } catch {
            return undefined;
        }
        return sidecarResult.kind === 'valid' ? sidecarResult.metadata : undefined;
    }

    private cacheEntryProvesSourceMetadataIdentity(
        sidecar: InlineScriptEnvMeta,
        environment: PythonEnvironment,
        metadataIdentity: string,
        metadata: InlineScriptMetadata,
    ): boolean {
        return (
            this.sidecarProvesSourceMetadataIdentity(sidecar, metadataIdentity) ||
            this.isMetadataOnlyCacheEntryForMetadata(sidecar, environment, metadata)
        );
    }

    private async resolveVerifiedSourceMetadataIdentity(
        script: ScriptReference,
        environment: PythonEnvironment,
        savedMetadata: SavedMetadataSnapshot,
    ): Promise<string | undefined> {
        if (savedMetadata.identity) {
            return savedMetadata.metadata &&
                (await this.currentCacheEntryProvesSourceMetadataIdentity(
                    environment,
                    savedMetadata.identity,
                    savedMetadata.metadata,
                ))
                ? savedMetadata.identity
                : undefined;
        }

        const persistedSourceMetadataIdentity = this.getPersistedSourceMetadataIdentity(
            script.scriptPath,
            environment.environmentPath.fsPath,
        );
        if (persistedSourceMetadataIdentity) {
            const sidecar = await this.readCurrentCacheEntrySidecar(environment);
            if (sidecar && this.sidecarProvesSourceMetadataIdentity(sidecar, persistedSourceMetadataIdentity)) {
                return persistedSourceMetadataIdentity;
            }
        }

        const savedSourceMetadata = await this.readSavedMetadataSnapshot(script.uri);
        if (!savedSourceMetadata.identity || !savedSourceMetadata.metadata) {
            return undefined;
        }
        return (await this.currentCacheEntryProvesSourceMetadataIdentity(
            environment,
            savedSourceMetadata.identity,
            savedSourceMetadata.metadata,
        ))
            ? savedSourceMetadata.identity
            : undefined;
    }

    private sidecarProvesSourceMetadataIdentity(
        sidecar: InlineScriptEnvMeta,
        metadataIdentity: string,
    ): boolean {
        if (sidecar.sourceMetadataIdentityHashes === undefined) {
            return false;
        }
        const expectedHash = hashSourceMetadataIdentity(metadataIdentity);
        return sidecar.sourceMetadataIdentityHashes.includes(expectedHash);
    }

    private isMetadataOnlyCacheEntryForMetadata(
        sidecar: InlineScriptEnvMeta,
        environment: PythonEnvironment,
        metadata: InlineScriptMetadata,
    ): boolean {
        if (sidecar.sourceMetadataIdentityHashes !== undefined) {
            return false;
        }
        const expectedCacheKey = computeCacheKey({
            dependencies: metadata.dependencies ?? [],
            interpreterPath: sidecar.baseInterpreterPath,
        });
        if (
            normalizePath(getScriptEnvDir(this.globalStorageUri, expectedCacheKey).fsPath) !==
            normalizePath(environment.sysPrefix)
        ) {
            return false;
        }
        const requiresPython = metadata.requiresPython?.trim();
        return !requiresPython || this.matchesInstallConstraint(requiresPython, environment.version);
    }

    private getPersistedSourceMetadataIdentity(scriptPath: string, environmentPath: string): string | undefined {
        const persistedAssociation = this.fsPathToPersistedAssociation.get(scriptPath);
        return persistedAssociation &&
            normalizePath(persistedAssociation.environmentPath) === normalizePath(environmentPath) &&
            (persistedAssociation.metadataBinding.kind === 'matched' ||
                persistedAssociation.metadataBinding.kind === 'pending')
            ? persistedAssociation.metadataBinding.sourceIdentity
            : undefined;
    }

    private async bindPendingMetadataIdentity(
        scriptPath: string,
        environmentPath: string,
        metadataIdentity: string,
        metadataRevision: number,
        associationRevision: number,
        uri: Uri,
    ): Promise<'bound' | 'stale' | 'failed'> {
        return this.enqueueSelection(async () => {
            if (
                !this.isCurrentAssociationRevision(scriptPath, associationRevision) ||
                !this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)
            ) {
                return 'stale';
            }
            const expectedAssociation: PersistedAssociationRecord = {
                environmentPath,
                metadataBinding: { kind: 'pending', sourceIdentity: metadataIdentity },
            };
            const matchedAssociation: PersistedAssociationRecord = {
                environmentPath,
                metadataBinding: { kind: 'matched', sourceIdentity: metadataIdentity },
            };
            if (!this.isSamePersistedAssociation(this.fsPathToPersistedAssociation.get(scriptPath), expectedAssociation)) {
                return 'stale';
            }
            try {
                await this.updatePersistedAssociations([
                    {
                        scriptPath,
                        persistedAssociation: matchedAssociation,
                        expectedPersistedAssociation: expectedAssociation,
                    },
                ]);
            } catch (error) {
                this.log.warn(`Failed to bind inline-script metadata identity: ${getErrorMessage(error)}`);
                return 'failed';
            }
            if (
                !this.isCurrentAssociationRevision(scriptPath, associationRevision) ||
                !this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision)
            ) {
                return 'stale';
            }
            return this.isSamePersistedAssociation(this.fsPathToPersistedAssociation.get(scriptPath), matchedAssociation)
                ? 'bound'
                : 'stale';
        });
    }

    private isCurrentMetadataRefreshTask(
        uri: Uri,
        metadataIdentity: string,
        metadataRevision: number,
        scriptPath: string,
        associationRevision: number,
    ): boolean {
        return (
            this.isCurrentRoutingMetadata(uri, metadataIdentity, metadataRevision) &&
            this.isCurrentAssociationRevision(scriptPath, associationRevision)
        );
    }

    private isCurrentRoutingMetadata(uri: Uri, metadataIdentity: string, metadataRevision: number): boolean {
        return (
            this.routingRegistry.getMetadataIdentity(uri) === metadataIdentity &&
            this.routingRegistry.getMetadataRevision(uri) === metadataRevision
        );
    }

    private clearValidatedRouteableState(script: Uri | string): void {
        const scriptPath = typeof script === 'string' ? script : normalizePath(script.fsPath);
        this.invalidateCachedAssociationValidation(scriptPath);
        this.routingRegistry.setValidatedAssociation(script, false);
    }

    private invalidateCachedAssociationValidation(scriptPath: string): void {
        this.cachedAssociationValidatedAt.delete(scriptPath);
        this.lastValidatedMetadataIdentities.delete(scriptPath);
        this.lastValidatedMetadataIdentityProofs.delete(scriptPath);
    }

    private initializePersistedAssociations(): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const rawAssociations = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
            const parsed = this.parsePersistedAssociations(rawAssociations);
            this.applyPersistedAssociations(parsed?.records ?? {});
        }).then(async () => {
            await Promise.all(
                [...this.fsPathToPersistedAssociation.keys()].map(async (scriptPath) => {
                    const uri = this.routingRegistry.getUri(scriptPath);
                    const metadata = this.routingRegistry.getMetadata(scriptPath);
                    if (uri && metadata) {
                        await this.refreshValidatedAssociationForMetadata(
                            uri,
                            metadata,
                            getInlineScriptMetadataRoutingIdentity(metadata)!,
                            this.routingRegistry.getMetadataRevision(uri),
                        );
                    }
                }),
            );
        });
    }

    private async getPersistedAssociation(scriptPath: string): Promise<PersistedAssociationRecord | undefined> {
        await this.persistenceQueue;
        const state = await getWorkspacePersistentState();
        const rawAssociations = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
        if (rawAssociations === undefined) {
            this.applyPersistedAssociations({});
            return undefined;
        }
        const parsed = this.parsePersistedAssociations(rawAssociations);
        if (!parsed) {
            await this.removeInvalidPersistedAssociation(scriptPath);
            return this.getPersistedAssociationFromMemory(scriptPath);
        }
        const rawValue = (rawAssociations as Record<string, unknown>)[scriptPath];
        if (rawValue !== undefined && this.parsePersistedAssociationValue(rawValue).kind === 'invalid') {
            await this.removeInvalidPersistedAssociation(scriptPath);
            return this.getPersistedAssociationFromMemory(scriptPath);
        }
        this.applyPersistedAssociations(parsed.records);
        return this.getPersistedAssociationFromMemory(scriptPath);
    }

    private async removeStalePersistedAssociation(
        scriptPath: string,
        expectedEnvironmentPath: string,
        revision: number,
        scriptUri?: Uri,
        expectedPersistedAssociation?: PersistedAssociationRecord,
    ): Promise<void> {
        await this.enqueueSelection(async () => {
            if (!this.isCurrentAssociationRevision(scriptPath, revision)) {
                return;
            }
            try {
                const persistedPathBeforeUpdate = this.fsPathToPersistedAssociation.get(scriptPath)?.environmentPath;
                await this.updatePersistedAssociations([
                    {
                        scriptPath,
                        expectedEnvironmentPath,
                        expectedPersistedAssociation,
                    },
                ]);
                if (
                    normalizePath(persistedPathBeforeUpdate ?? '') === normalizePath(expectedEnvironmentPath) &&
                    !this.fsPathToPersistedAssociation.has(scriptPath) &&
                    this.isCurrentAssociationRevision(scriptPath, revision)
                ) {
                    const old = this.fsPathToEnv.get(scriptPath);
                    this.bumpAssociationRevision(scriptPath);
                    this.fsPathToEnv.delete(scriptPath);
                    this.fsPathToPersistedAssociation.delete(scriptPath);
                    this.clearValidatedRouteableState(scriptPath);
                    if (old && scriptUri) {
                        this._onDidChangeEnvironment.fire({ uri: scriptUri, old, new: undefined });
                    }
                }
            } catch (error) {
                this.log.warn(
                    `Failed to remove stale inline-script environment association: ${getErrorMessage(error)}`,
                );
            }
        });
    }

    private removeInvalidPersistedAssociation(scriptPath: string): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const rawAssociations = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
            if (rawAssociations === undefined) {
                this.applyPersistedAssociations({});
                return;
            }
            const parsed = this.parsePersistedAssociations(rawAssociations);
            if (!parsed) {
                await state.set(INLINE_SCRIPT_ENVS_KEY, {});
                this.applyPersistedAssociations({});
                return;
            }
            if (parsed.invalidKeys.has(scriptPath)) {
                delete parsed.rawEntries[scriptPath];
                delete parsed.records[scriptPath];
                parsed.invalidKeys.delete(scriptPath);
                await state.set(INLINE_SCRIPT_ENVS_KEY, parsed.rawEntries);
            }
            this.applyPersistedAssociations(parsed.records);
        });
    }

    private updatePersistedAssociations(changes: readonly PersistedAssociationChange[]): Promise<void> {
        return this.enqueuePersistence(async (state) => {
            const rawAssociations = await state.get<unknown>(INLINE_SCRIPT_ENVS_KEY);
            const parsed = this.parsePersistedAssociations(rawAssociations);
            const rawEntries = { ...(parsed?.rawEntries ?? {}) };
            const associations = { ...(parsed?.records ?? {}) };
            for (const change of changes) {
                const current = associations[change.scriptPath];
                if (change.persistedAssociation) {
                    if (
                        change.expectedPersistedAssociation &&
                        !this.isSamePersistedAssociation(current, change.expectedPersistedAssociation)
                    ) {
                        continue;
                    }
                    associations[change.scriptPath] = change.persistedAssociation;
                    rawEntries[change.scriptPath] = this.serializePersistedAssociation(change.persistedAssociation);
                } else if (
                    (change.expectedPersistedAssociation &&
                        this.isSamePersistedAssociation(current, change.expectedPersistedAssociation)) ||
                    (change.expectedPersistedAssociation === undefined &&
                        (change.expectedEnvironmentPath === undefined ||
                            (current !== undefined &&
                                normalizePath(current.environmentPath) === normalizePath(change.expectedEnvironmentPath))))
                ) {
                    delete associations[change.scriptPath];
                    delete rawEntries[change.scriptPath];
                }
            }
            await state.set(INLINE_SCRIPT_ENVS_KEY, rawEntries);
            this.applyPersistedAssociations(associations);
        });
    }

    private parsePersistedAssociations(value: unknown): ParsedPersistedAssociations | undefined {
        if (value === undefined) {
            return {
                rawEntries: {},
                records: {},
                invalidKeys: new Set<string>(),
            };
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        const rawEntries = { ...(value as Record<string, unknown>) };
        const records: PersistedInlineScriptEnvironments = {};
        const invalidKeys = new Set<string>();
        for (const [scriptPath, association] of Object.entries(rawEntries)) {
            const parsed = this.parsePersistedAssociationValue(association);
            if (parsed.kind === 'valid') {
                records[scriptPath] = parsed.record;
            } else if (parsed.kind === 'invalid') {
                invalidKeys.add(scriptPath);
            }
        }
        return { rawEntries, records, invalidKeys };
    }

    private getPersistedAssociationFromMemory(scriptPath: string): PersistedAssociationRecord | undefined {
        return this.fsPathToPersistedAssociation.get(scriptPath);
    }

    private createPersistedAssociationRecord(
        environmentPath: string,
        sourceMetadataIdentity: string | undefined,
        currentMetadataIdentity: string | undefined,
    ): PersistedAssociationRecord {
        if (!sourceMetadataIdentity) {
            return {
                environmentPath,
                metadataBinding: { kind: 'legacy' },
            };
        }
        return {
            environmentPath,
            metadataBinding:
                currentMetadataIdentity === sourceMetadataIdentity
                    ? { kind: 'matched', sourceIdentity: sourceMetadataIdentity }
                    : { kind: 'pending', sourceIdentity: sourceMetadataIdentity },
        };
    }

    private isSamePersistedAssociation(
        first: PersistedAssociationRecord | undefined,
        second: PersistedAssociationRecord | undefined,
    ): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second) {
            return false;
        }
        if (normalizePath(first.environmentPath) !== normalizePath(second.environmentPath)) {
            return false;
        }
        if (first.metadataBinding.kind !== second.metadataBinding.kind) {
            return false;
        }
        if (first.metadataBinding.kind === 'matched' && second.metadataBinding.kind === 'matched') {
            return first.metadataBinding.sourceIdentity === second.metadataBinding.sourceIdentity;
        }
        if (first.metadataBinding.kind === 'pending' && second.metadataBinding.kind === 'pending') {
            return first.metadataBinding.sourceIdentity === second.metadataBinding.sourceIdentity;
        }
        return true;
    }

    private parsePersistedAssociationValue(value: unknown):
        | { readonly kind: 'valid'; readonly record: PersistedAssociationRecord }
        | { readonly kind: 'future' }
        | { readonly kind: 'invalid' } {
        if (typeof value === 'string' && value.length > 0) {
            return {
                kind: 'valid',
                record: {
                    environmentPath: value,
                    metadataBinding: { kind: 'legacy' },
                },
            };
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { kind: 'invalid' };
        }
        const association = value as Record<string, unknown>;
        const schemaVersion = association.schemaVersion;
        if (typeof schemaVersion !== 'number') {
            return { kind: 'invalid' };
        }
        if (schemaVersion !== PERSISTED_ASSOCIATION_SCHEMA_VERSION) {
            return { kind: 'future' };
        }
        const environmentPath = association.environmentPath;
        const metadataBinding = association.metadataBinding;
        if (typeof environmentPath !== 'string' || environmentPath.length === 0) {
            return { kind: 'invalid' };
        }
        if (!metadataBinding || typeof metadataBinding !== 'object' || Array.isArray(metadataBinding)) {
            return { kind: 'invalid' };
        }
        const binding = metadataBinding as Record<string, unknown>;
        if (binding.kind === 'pending') {
            if (typeof binding.sourceIdentity === 'string' && binding.sourceIdentity.trim().length > 0) {
                return {
                    kind: 'valid',
                    record: {
                        environmentPath,
                        metadataBinding: { kind: 'pending', sourceIdentity: binding.sourceIdentity },
                    },
                };
            }
            return { kind: 'invalid' };
        }
        if (binding.kind === 'legacy') {
            return {
                kind: 'valid',
                record: { environmentPath, metadataBinding: { kind: 'legacy' } },
            };
        }
        if (
            binding.kind === 'matched' &&
            typeof binding.sourceIdentity === 'string' &&
            binding.sourceIdentity.trim().length > 0
        ) {
            return {
                kind: 'valid',
                record: {
                    environmentPath,
                    metadataBinding: {
                        kind: 'matched',
                        sourceIdentity: binding.sourceIdentity,
                    },
                },
            };
        }
        return { kind: 'invalid' };
    }

    private serializePersistedAssociation(
        association: PersistedAssociationRecord,
    ): PersistedInlineScriptAssociationValue {
        return {
            schemaVersion: PERSISTED_ASSOCIATION_SCHEMA_VERSION,
            environmentPath: association.environmentPath,
            metadataBinding:
                association.metadataBinding.kind === 'matched'
                    ? { kind: 'matched', sourceIdentity: association.metadataBinding.sourceIdentity }
                    : association.metadataBinding.kind === 'pending'
                      ? { kind: 'pending', sourceIdentity: association.metadataBinding.sourceIdentity }
                      : { kind: association.metadataBinding.kind },
        };
    }

    private enqueuePersistence(operation: (state: PersistentState) => Promise<void>): Promise<void> {
        const run = this.persistenceQueue.then(async () => operation(await getWorkspacePersistentState()));
        this.persistenceQueue = run.catch(() => undefined);
        return run;
    }

    private enqueueSelection<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.selectionQueue.then(operation);
        this.selectionQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private clearAssociationsForScripts(scripts: readonly Uri[]): Promise<void> {
        return this.enqueueSelection(async () => {
            const changes = scripts
                .filter((uri) => uri.scheme === 'file')
                .map((uri) => ({
                    uri,
                    scriptPath: normalizePath(uri.fsPath),
                }))
                .filter((script, index, all) => all.findIndex((candidate) => candidate.scriptPath === script.scriptPath) === index)
                .filter(
                    (script) =>
                        this.fsPathToEnv.has(script.scriptPath) ||
                        this.fsPathToPersistedAssociation.has(script.scriptPath),
                );

            if (changes.length === 0) {
                return;
            }

            await this.updatePersistedAssociations(changes.map(({ scriptPath }) => ({ scriptPath })));
            for (const change of changes) {
                this.bumpAssociationRevision(change.scriptPath);
                this.pendingRehydrations.delete(change.scriptPath);
                this.pendingMetadataRefreshes.delete(change.scriptPath);
                this.fsPathToEnv.delete(change.scriptPath);
                this.fsPathToPersistedAssociation.delete(change.scriptPath);
                this.clearValidatedRouteableState(change.uri);
            }
        });
    }

    private async isCacheEntryBusy(envDirPath: string): Promise<boolean> {
        return (
            this.pendingCreations.has(path.basename(envDirPath)) ||
            (await fs.pathExists(`${path.resolve(envDirPath)}.lock`))
        );
    }

    private bumpAssociationRevision(scriptPath: string): void {
        this.associationRevisions.set(scriptPath, (this.associationRevisions.get(scriptPath) ?? 0) + 1);
    }

    private isCurrentAssociationRevision(scriptPath: string, revision: number): boolean {
        return (this.associationRevisions.get(scriptPath) ?? 0) === revision;
    }

    private isSameEnvironment(
        first: PythonEnvironment | undefined,
        second: PythonEnvironment | undefined,
    ): boolean {
        if (first === second) {
            return true;
        }
        if (!first || !second) {
            return false;
        }
        return (
            first.envId.managerId === second.envId.managerId &&
            normalizePath(first.environmentPath.fsPath) === normalizePath(second.environmentPath.fsPath) &&
            first.version === second.version
        );
    }

    private async selectBaseInterpreter(metadata: InlineScriptMetadata): Promise<SelectedBaseInterpreter | undefined> {
        let globalEnvironments: readonly PythonEnvironment[] = [];
        try {
            globalEnvironments = await this.api.getEnvironments('global');
        } catch (error) {
            this.log.warn(`Unable to query discovered base interpreters: ${getErrorMessage(error)}`);
        }
        const reported = [
            ...globalEnvironments.filter(
                (environment) =>
                    BASE_INTERPRETER_MANAGER_IDS.has(environment.envId.managerId) &&
                    (environment.envId.managerId !== CONDA_MANAGER_ID || environment.name === 'base'),
            ),
            ...[...this.directlyResolvedBaseInterpreters.values()].filter(
                (environment) =>
                    !metadata.requiresPython ||
                    this.matchesInstallConstraint(metadata.requiresPython, environment.version),
            ),
        ];
        const derivedChecks = await Promise.all(
            reported.map(async (environment) => {
                if (!path.isAbsolute(environment.sysPrefix)) {
                    this.log.warn(
                        `Skipping base interpreter with a non-absolute sysPrefix: ${environment.sysPrefix || '<empty>'}.`,
                    );
                    return { environment, derived: true };
                }
                return {
                    environment,
                    derived: await fs.pathExists(path.join(environment.sysPrefix, 'pyvenv.cfg')),
                };
            }),
        );
        let candidates = derivedChecks
            .filter(
                (candidate) =>
                    !candidate.derived &&
                    (!metadata.requiresPython ||
                        this.matchesInstallConstraint(metadata.requiresPython, candidate.environment.version)),
            )
            .map((candidate) => candidate.environment);

        while (candidates.length > 0) {
            const environment = pickCompatibleInterpreter(candidates, undefined);
            if (!environment) {
                return undefined;
            }
            candidates = candidates.filter((candidate) => candidate !== environment);

            const executable = environment.execInfo?.run.executable;
            if (!executable) {
                continue;
            }
            try {
                return { environment, canonicalPath: await fs.realpath(executable) };
            } catch (error) {
                this.log.warn(
                    `Skipping base interpreter that cannot be resolved at ${executable}: ${getErrorMessage(error)}`,
                );
            }
        }

        return undefined;
    }

    private async installAndSelectBaseInterpreter(
        metadata: InlineScriptMetadata,
    ): Promise<SelectedBaseInterpreter | undefined> {
        const run = this.baseInterpreterInstallationQueue.then(() =>
            this.installAndSelectBaseInterpreterSerially(metadata),
        );
        // Keep the stored queue tail fulfilled so one failed request does not block later attempts;
        // the caller still observes the original result through `run`.
        this.baseInterpreterInstallationQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async installAndSelectBaseInterpreterSerially(
        metadata: InlineScriptMetadata,
    ): Promise<SelectedBaseInterpreter | undefined> {
        const existing = await this.selectBaseInterpreter(metadata);
        if (existing) {
            return existing;
        }

        const requiresPython = metadata.requiresPython?.trim() || undefined;
        const lowerBound = extractLowerBoundVersion(requiresPython);
        const version = await this.selectInstallablePythonVersion(requiresPython, lowerBound);
        if (requiresPython && !version) {
            this.log.warn(
                'Cannot install a Python for this inline script because no compatible install version could be selected.',
            );
            return undefined;
        }

        const installedPath = await this.installPythonAndRefresh(requiresPython, version);
        if (!installedPath) {
            return undefined;
        }

        let selected: SelectedBaseInterpreter | undefined;
        try {
            selected = await this.selectBaseInterpreter(metadata);
        } catch (error) {
            this.log.warn(
                `Unable to refresh base-interpreter discovery after installing Python: ${getErrorMessage(error)}`,
            );
        }
        if (!selected) {
            const resolved = await resolveSystemPythonEnvironmentPath(
                installedPath,
                this.nativeFinder,
                this.api,
                this.baseManager,
            );
            const executable = resolved?.execInfo?.run.executable;
            if (resolved && executable && pickCompatibleInterpreter([resolved], metadata.requiresPython)) {
                try {
                    const canonicalPath = await fs.realpath(executable);
                    if (!requiresPython || this.matchesInstallConstraint(requiresPython, resolved.version)) {
                        this.directlyResolvedBaseInterpreters.set(canonicalPath, resolved);
                        selected = {
                            environment: resolved,
                            canonicalPath,
                        };
                    }
                } catch (error) {
                    this.log.warn(
                        `Unable to resolve the Python installed for an inline script at ${executable}: ${getErrorMessage(error)}`,
                    );
                }
            }
        }
        if (!selected) {
            this.log.warn(
                'Python was installed for an inline script, but no compatible base interpreter was discovered after refreshing environments.',
            );
        }
        return selected;
    }

    private async selectInstallablePythonVersion(
        requiresPython: string | undefined,
        lowerBound: string | undefined,
    ): Promise<string | undefined> {
        if (!requiresPython) {
            return lowerBound;
        }
        const prereleaseLowerBound = this.extractPrereleaseLowerBound(requiresPython);
        if (prereleaseLowerBound) {
            return prereleaseLowerBound;
        }
        const lowerBoundRelease = lowerBound ? parseReleaseSegments(lowerBound) : undefined;
        if (lowerBound && lowerBoundRelease?.[0] === 3) {
            if (/^>=\s*[^,]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                return lowerBound;
            }
            if (/^==\s*[^,*]+$/.test(requiresPython) && this.matchesInstallConstraint(requiresPython, lowerBound)) {
                return lowerBound;
            }
        }

        let available: uvPythonInstaller.UvPythonVersion[];
        try {
            if (!(await uvPythonInstaller.ensureUvForInlineScriptVersionLookup(requiresPython, this.log))) {
                return undefined;
            }
            available = await uvPythonInstaller.getAvailablePythonVersions();
        } catch (error) {
            this.log.warn(`Unable to query Python versions available from uv: ${getErrorMessage(error)}`);
            return undefined;
        }
        return available
            .filter(
                (candidate) =>
                    candidate.implementation === 'cpython' &&
                    candidate.variant === 'default' &&
                    candidate.version_parts.major === 3 &&
                    this.matchesInstallConstraint(requiresPython, candidate.version),
            )
            .sort((left, right) => {
                const leftRelease = parseReleaseSegments(left.version);
                const rightRelease = parseReleaseSegments(right.version);
                if (!leftRelease || !rightRelease) {
                    return 0;
                }
                return compareReleaseSegments(rightRelease, leftRelease);
            })[0]?.version;
    }

    private matchesInstallConstraint(requiresPython: string, version: string): boolean {
        try {
            return satisfiesPep440(version, requiresPython, {
                prereleases: /(?:(?:a|alpha|b|beta|c|rc|pre|preview)[._-]?\d+|dev[._-]?\d+)/i.test(
                    requiresPython,
                ),
            });
        } catch (error) {
            this.log.warn(`Unable to evaluate requires-python '${requiresPython}': ${getErrorMessage(error)}`);
            return false;
        }
    }

    private extractPrereleaseLowerBound(requiresPython: string): string | undefined {
        return requiresPython
            .split(',')
            .map((clause) =>
                clause
                    .trim()
                    .match(
                        /^(?:>=|==|~=)\s*(\d+(?:\.\d+)*(?:(?:a|alpha|b|beta|c|rc|pre|preview)[._-]?\d+|[._-]?dev[._-]?\d+))$/i,
                    )?.[1],
            )
            .map((version) => (version ? cleanPep440(version) : undefined))
            .filter((version): version is string => !!version)
            .find((version) => this.matchesInstallConstraint(requiresPython, version));
    }

    private async installPythonAndRefresh(
        requiresPython: string | undefined,
        version: string | undefined,
    ): Promise<string | undefined> {
        let installedPath: string | undefined;
        try {
            installedPath = await uvPythonInstaller.promptInstallPythonViaUv('inlineScript', this.log, {
                requiresPython,
                version,
            });
            if (!installedPath) {
                this.log.warn(
                    'Python installation for inline-script environment creation was declined or did not complete.',
                );
                return undefined;
            }
        } catch (error) {
            this.log.error(`Failed to install Python for an inline script: ${getErrorMessage(error)}`);
            return undefined;
        }

        try {
            await this.api.refreshEnvironments(undefined);
        } catch (error) {
            this.log.warn(
                `Python was installed for an inline script, but environment discovery could not be refreshed: ${getErrorMessage(error)}`,
            );
        }
        return installedPath;
    }

    private async withCacheEntryLock<T>(
        envDir: Uri,
        action: (lock: AcquiredFileLock) => Promise<T>,
    ): Promise<T> {
        const lock = await acquireFileLock(envDir.fsPath, {
            timeoutMs: CACHE_LOCK_TIMEOUT_MS,
            retryIntervalMs: CACHE_LOCK_RETRY_MS,
        });
        try {
            return await action(lock);
        } finally {
            try {
                await lock.release();
            } catch (error) {
                this.log.warn(`Failed to release inline-script cache lock: ${getErrorMessage(error)}`);
            }
        }
    }

    private mergePendingCreationSourceMetadataIdentityHashes(
        existing: readonly string[] | undefined,
        pendingCreation: PendingCreationContext,
    ): readonly string[] | undefined {
        let merged = existing;
        for (const sourceMetadataIdentityHash of pendingCreation.sourceMetadataIdentityHashes ?? []) {
            merged = mergeSourceMetadataIdentityHashes(merged, sourceMetadataIdentityHash);
        }
        return merged;
    }

    private async mergeCacheEntrySourceMetadataIdentityHash(
        cacheKey: string,
        sourceMetadataIdentityHash: string,
    ): Promise<MergeCacheEntrySourceMetadataIdentityHashResult> {
        const envDir = getScriptEnvDir(this.globalStorageUri, cacheKey);
        try {
            return await this.withCacheEntryLock(envDir, async () => {
                const sidecarResult = await inspectMetaJson(envDir);
                if (sidecarResult.kind !== 'valid') {
                    return { success: false };
                }
                if (sidecarResult.metadata.sourceMetadataIdentityHashes?.includes(sourceMetadataIdentityHash)) {
                    return {
                        success: true,
                        sourceMetadataIdentityHashes: sidecarResult.metadata.sourceMetadataIdentityHashes,
                    };
                }
                const sourceMetadataIdentityHashes = mergeSourceMetadataIdentityHashes(
                    sidecarResult.metadata.sourceMetadataIdentityHashes,
                    sourceMetadataIdentityHash,
                );
                await writeMetaJson(envDir, {
                    ...sidecarResult.metadata,
                    ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
                });
                return {
                    success: true,
                    sourceMetadataIdentityHashes,
                };
            });
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache provenance: ${getErrorMessage(error)}`);
            return { success: false };
        }
    }

    private async createOrReuseEnvironment({
        cacheKey,
        packages,
        metadata,
        selectedBase,
        pendingCreation,
    }: CreateOrReuseEnvironmentOptions): Promise<PythonEnvironment | undefined> {
        const cacheRoot = getScriptEnvCacheRoot(this.globalStorageUri);
        const envDir = getScriptEnvDir(this.globalStorageUri, cacheKey);
        await fs.ensureDir(cacheRoot.fsPath);

        try {
            return await this.withCacheEntryLock(envDir, async (lock) => {
                const cached = await this.inspectCacheEntry(
                    cacheRoot,
                    envDir,
                    metadata,
                    selectedBase,
                    pendingCreation,
                );
                if (cached.kind === 'reusable') {
                    return cached.environment;
                }
                if (cached.kind === 'uncertain') {
                    this.log.warn(
                        `Preserving an inline-script cache entry that could not be safely inspected: ${envDir.fsPath}`,
                    );
                    return undefined;
                }
                if (cached.kind === 'stale') {
                    if (!(await this.removeCacheEntry(envDir))) {
                        return undefined;
                    }
                }

                const build = await this.buildCacheEntry(
                    envDir,
                    cacheRoot,
                    packages,
                    selectedBase,
                    pendingCreation,
                );
                if (build.retainLock) {
                    try {
                        await lock.retain();
                    } catch (error) {
                        this.log.error(
                            `Failed to mark the inline-script cache lock as retained: ${getErrorMessage(error)}`,
                        );
                    }
                }
                return build.environment;
            });
        } catch (error) {
            this.log.error(`Failed to create or reuse inline-script cache entry: ${getErrorMessage(error)}`);
            return undefined;
        }
    }

    private async inspectCacheEntry(
        cacheRoot: Uri,
        envDir: Uri,
        metadata: InlineScriptMetadata,
        selectedBase: SelectedBaseInterpreter,
        pendingCreation: PendingCreationContext,
    ): Promise<CacheEntryInspection> {
        try {
            const stat = await fs.lstat(envDir.fsPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                return { kind: 'uncertain' };
            }
        } catch (error) {
            return isFileNotFoundError(error) ? { kind: 'absent' } : { kind: 'uncertain' };
        }

        let resolvedEntry: string | undefined;
        try {
            resolvedEntry = await resolveCacheEntryPath(cacheRoot, envDir);
        } catch (error) {
            this.log.warn(`Failed to resolve inline-script cache entry: ${getErrorMessage(error)}`);
            return { kind: 'uncertain' };
        }
        if (!resolvedEntry) {
            return { kind: 'uncertain' };
        }

        let sidecarResult;
        try {
            sidecarResult = await inspectMetaJson(envDir);
        } catch {
            return { kind: 'uncertain' };
        }
        if (sidecarResult.kind !== 'valid') {
            return {
                kind:
                    sidecarResult.kind === 'unavailable' || sidecarResult.kind === 'unsupported'
                        ? 'uncertain'
                        : 'stale',
            };
        }
        const sidecar = sidecarResult.metadata;
        if (
            normalizePath(sidecar.baseInterpreterPath) !== normalizePath(selectedBase.canonicalPath) ||
            sidecar.baseInterpreterVersion !== selectedBase.environment.version
        ) {
            return { kind: 'stale' };
        }

        const baseInterpreterStatus = await getBaseInterpreterStatus(envDir);
        if (baseInterpreterStatus !== 'available') {
            return { kind: baseInterpreterStatus === 'missing' ? 'stale' : 'uncertain' };
        }

        const environment = await resolveVenvPythonEnvironmentPath(
            getVenvPythonPath(envDir.fsPath),
            this.nativeFinder,
            this.api,
            this,
            this.baseManager,
        );
        if (!environment) {
            return { kind: 'uncertain' };
        }
        const environmentStatus = await inspectOwnedCacheEntry(environment, cacheRoot, envDir);
        if (environmentStatus !== 'expected') {
            return { kind: environmentStatus };
        }
        if (!this.areEqualPythonReleases(environment.version, selectedBase.environment.version)) {
            return { kind: 'stale' };
        }
        const requiresPython = metadata.requiresPython?.trim();
        if (requiresPython && !this.matchesInstallConstraint(requiresPython, environment.version)) {
            return { kind: 'stale' };
        }
        try {
            pendingCreation.hasStartedRecordingSourceMetadataIdentityHashes = true;
            const sourceMetadataIdentityHashes = this.mergePendingCreationSourceMetadataIdentityHashes(
                sidecar.sourceMetadataIdentityHashes,
                pendingCreation,
            );
            await writeMetaJson(envDir, {
                ...sidecar,
                lastUsedAt: new Date().toISOString(),
                ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
            });
            pendingCreation.recordedSourceMetadataIdentityHashes = sourceMetadataIdentityHashes;
        } catch (error) {
            this.log.warn(`Failed to update inline-script cache metadata: ${getErrorMessage(error)}`);
        }
        return { kind: 'reusable', environment };
    }

    private async buildCacheEntry(
        envDir: Uri,
        cacheRoot: Uri,
        packages: ReadonlyArray<string>,
        selectedBase: SelectedBaseInterpreter,
        pendingCreation: PendingCreationContext,
    ): Promise<BuildCacheEntryResult> {
        let result;
        try {
            result = await createWithProgress(
                this.nativeFinder,
                this.api,
                this.log,
                this,
                selectedBase.environment,
                cacheRoot,
                envDir.fsPath,
                { install: [...packages], uninstall: [] },
                false, // trackUvEnvironment
            );
        } catch (error) {
            this.log.error(`Failed to build inline-script environment: ${getErrorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return {};
        }

        if (result?.pkgInstallationCancelled) {
            this.log.warn(
                'Inline-script package installation was cancelled; retaining the cache lock until explicit cleanup.',
            );
            return { retainLock: true };
        }
        if (!result?.environment || result.envCreationErr || result.pkgInstallationErr) {
            const error =
                result?.envCreationErr ?? result?.pkgInstallationErr ?? 'environment creation returned no result';
            this.log.error(`Failed to build inline-script environment: ${error}`);
            await this.removeCacheEntry(envDir);
            return {};
        }
        if (
            !this.areEqualPythonReleases(result.environment.version, selectedBase.environment.version) ||
            (await inspectOwnedCacheEntry(result.environment, cacheRoot, envDir)) !== 'expected'
        ) {
            this.log.error('Created inline-script environment does not match the requested cache entry.');
            await this.removeCacheEntry(envDir);
            return {};
        }
        try {
            pendingCreation.hasStartedRecordingSourceMetadataIdentityHashes = true;
            const sourceMetadataIdentityHashes = this.mergePendingCreationSourceMetadataIdentityHashes(
                undefined,
                pendingCreation,
            );
            await writeMetaJson(envDir, {
                schemaVersion: META_SCHEMA_VERSION,
                baseInterpreterPath: selectedBase.canonicalPath,
                baseInterpreterVersion: selectedBase.environment.version,
                lastUsedAt: new Date().toISOString(),
                ...(sourceMetadataIdentityHashes ? { sourceMetadataIdentityHashes } : {}),
            });
            pendingCreation.recordedSourceMetadataIdentityHashes = sourceMetadataIdentityHashes;
        } catch (error) {
            this.log.error(`Failed to record inline-script cache metadata: ${getErrorMessage(error)}`);
            await this.removeCacheEntry(envDir);
            return {};
        }

        return { environment: result.environment };
    }

    private async removeCacheEntry(envDir: Uri): Promise<boolean> {
        try {
            await fs.remove(envDir.fsPath);
            return true;
        } catch (error) {
            this.log.error(`Failed to remove incomplete inline-script environment: ${getErrorMessage(error)}`);
            return false;
        }
    }

    private isDefinitivelyStalePathError(error: unknown): boolean {
        if (isFileNotFoundError(error)) {
            return true;
        }
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['ENOTDIR', 'EINVAL', 'ERR_INVALID_ARG_VALUE'].includes((error as NodeJS.ErrnoException).code ?? '')
        );
    }

    private areEqualPythonReleases(actual: string, expected: string): boolean {
        const actualRelease = parseReleaseSegments(actual);
        const expectedRelease = parseReleaseSegments(expected);
        if (actualRelease === undefined || expectedRelease === undefined) {
            return false;
        }
        return compareReleaseSegments(actualRelease, expectedRelease) === 0;
    }

    dispose(): void {
        this.pendingMetadataRefreshes.clear();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this._onDidChangeEnvironments.dispose();
        this._onDidChangeEnvironment.dispose();
    }

    private applyPersistedAssociations(associations: PersistedInlineScriptEnvironments): void {
        const nextPaths = new Set(Object.keys(associations));
        for (const scriptPath of this.fsPathToPersistedAssociation.keys()) {
            if (!nextPaths.has(scriptPath)) {
                this.fsPathToPersistedAssociation.delete(scriptPath);
                this.clearValidatedRouteableState(scriptPath);
            }
        }
        for (const [scriptPath, association] of Object.entries(associations)) {
            this.fsPathToPersistedAssociation.set(scriptPath, association);
        }
    }
}

type PersistedInlineScriptEnvironments = Record<string, PersistedAssociationRecord>;
type PersistedInlineScriptAssociationValue = string | PersistedInlineScriptAssociationObject;

type PersistedMetadataBinding =
    | { readonly kind: 'legacy' }
    | { readonly kind: 'pending'; readonly sourceIdentity: string }
    | { readonly kind: 'matched'; readonly sourceIdentity: string };

interface PersistedInlineScriptAssociationObject {
    readonly schemaVersion: typeof PERSISTED_ASSOCIATION_SCHEMA_VERSION;
    readonly environmentPath: string;
    readonly metadataBinding: PersistedMetadataBinding;
}

interface PersistedAssociationRecord {
    readonly environmentPath: string;
    readonly metadataBinding: PersistedMetadataBinding;
}

interface PersistedAssociationChange {
    readonly scriptPath: string;
    readonly persistedAssociation?: PersistedAssociationRecord;
    readonly expectedPersistedAssociation?: PersistedAssociationRecord;
    readonly expectedEnvironmentPath?: string;
}

interface ScriptReference {
    readonly uri: Uri;
    readonly scriptPath: string;
}

interface PendingScriptUpdate extends ScriptReference {
    readonly before: PythonEnvironment | undefined;
    readonly persistedAssociation?: PersistedAssociationRecord;
    readonly needsPersistence: boolean;
    readonly shouldNotify: boolean;
}
