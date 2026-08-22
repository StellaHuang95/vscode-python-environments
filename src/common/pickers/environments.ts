import { ProgressLocation, QuickInputButtons, QuickPickItem, QuickPickItemKind, ThemeIcon, Uri, l10n } from 'vscode';
import { CreateEnvironmentOptions, IconPath, PythonEnvironment, PythonProject } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { Common, Interpreter, Pickers } from '../localize';
import { traceError } from '../logging';
import { EventNames } from '../telemetry/constants';
import { sendTelemetryEvent } from '../telemetry/sender';
import { isWindows } from '../utils/platformUtils';
import { normalizePath } from '../utils/pathUtils';
import { handlePythonPath } from '../utils/pythonPath';
import {
    QuickPickController,
    showErrorMessage,
    showOpenDialog,
    showQuickPick,
    showQuickPickWithButtons,
    withProgress,
} from '../window.apis';
import { pickEnvironmentManager } from './managers';

type QuickPickIcon =
    | Uri
    | {
          light: Uri;
          dark: Uri;
      }
    | ThemeIcon
    | undefined;

function getIconPath(i: IconPath | undefined): QuickPickIcon {
    if (i === undefined || i instanceof ThemeIcon || i instanceof Uri) {
        return i;
    }

    if (typeof i === 'string') {
        return Uri.file(i);
    }

    return {
        light: i.light instanceof Uri ? i.light : Uri.file(i.light),
        dark: i.dark instanceof Uri ? i.dark : Uri.file(i.dark),
    };
}

interface EnvironmentPickOptions {
    recommended?: PythonEnvironment;
    showBackButton?: boolean;
    projects: PythonProject[];
}
async function browseForPython(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
): Promise<PythonEnvironment | undefined> {
    const filters = isWindows() ? { python: ['exe'] } : undefined;
    const uris = await showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters,
        title: Pickers.Environments.selectExecutable,
    });
    if (!uris || uris.length === 0) {
        return;
    }
    const uri = uris[0];

    const environment = await withProgress(
        {
            location: ProgressLocation.Notification,
            cancellable: false,
        },
        async (reporter, token) => {
            const env = await handlePythonPath(uri, managers, projectEnvManagers, reporter, token);
            return env;
        },
    );

    if (!environment) {
        showErrorMessage(l10n.t('Selected file is not a valid Python interpreter: {0}', uri.fsPath));
    }

    return environment;
}

async function createEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const managerId = await pickEnvironmentManager(
        managers.filter((m) => m.supportsCreate),
        projectEnvManagers.filter((m) => m.supportsCreate),
    );

    let manager: InternalEnvironmentManager | undefined;
    let createOptions: CreateEnvironmentOptions | undefined = undefined;
    if (managerId?.includes(`QuickCreate#`)) {
        manager = managers.find((m) => m.id === managerId.split('#')[1]);
        createOptions = {
            projects: projectEnvManagers.map((m) => m),
            quickCreate: true,
        } as CreateEnvironmentOptions;
    } else {
        manager = managers.find((m) => m.id === managerId);
    }

    if (manager) {
        try {
            // add telemetry here
            const env = await manager.create(
                options.projects.map((p) => p.uri),
                createOptions,
            );
            return env;
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                return createEnvironment(managers, projectEnvManagers, options);
            }
            traceError(`Failed to create environment using ${manager.id}`, ex);
            throw ex;
        }
    }
}

type EnvironmentQuickPickItem = QuickPickItem & {
    result: PythonEnvironment;
    manager: InternalEnvironmentManager;
};

type EnvironmentPickItem = QuickPickItem | (QuickPickItem & { result: PythonEnvironment });

/**
 * A manager's contribution to the picker, built exactly once when the manager's environments load.
 * Reusing the same separator/item object references across rebuilds lets the QuickPick preserve the
 * user's active/selected items by reference while more sections stream in.
 */
interface ManagerSection {
    readonly separator: QuickPickItem;
    readonly entries: ReadonlyArray<{ readonly key: string; readonly item: EnvironmentQuickPickItem }>;
}

/**
 * Computes a stable, cross-manager identity for an environment so the same interpreter discovered by
 * more than one manager is only shown once. Prefers the resolved executable path, then the
 * environment path, and finally the manager-scoped id. Paths are normalized for cross-platform
 * comparison.
 */
function environmentIdentityKey(e: PythonEnvironment): string {
    const execPath = e.execInfo?.run?.executable;
    if (execPath && execPath.trim().length > 0) {
        return normalizePath(execPath);
    }
    const envPath = e.environmentPath?.fsPath;
    if (envPath && envPath.trim().length > 0) {
        return normalizePath(envPath);
    }
    return `${e.envId.managerId}:${e.envId.id}`;
}

function createEnvironmentItem(
    e: PythonEnvironment,
    manager: InternalEnvironmentManager,
): EnvironmentQuickPickItem {
    const pathDescription = e.displayPath;
    const description =
        e.description && e.description.trim() ? `${e.description} (${pathDescription})` : pathDescription;

    return {
        label: e.displayName ?? e.name,
        description,
        result: e,
        manager,
        iconPath: getIconPath(e.iconPath),
    };
}

async function pickEnvironmentImpl(
    items: EnvironmentPickItem[],
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
    onDidShow?: (controller: QuickPickController<EnvironmentPickItem>) => void,
): Promise<PythonEnvironment | undefined> {
    const selected = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
        showBackButton: options?.showBackButton,
        onDidShow,
    });

    if (selected && !Array.isArray(selected)) {
        if (selected.label === Interpreter.browsePath) {
            return browseForPython(managers, projectEnvManagers);
        } else if (selected.label === Interpreter.createVirtualEnvironment) {
            sendTelemetryEvent(EventNames.CREATE_ENVIRONMENT, undefined, {
                manager: 'none',
                triggeredLocation: 'pickEnv',
            });
            return createEnvironment(managers, projectEnvManagers, options);
        }
        return (selected as { result: PythonEnvironment })?.result;
    }
    return undefined;
}

export async function pickEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const staticItems: EnvironmentPickItem[] = [
        {
            label: Interpreter.browsePath,
            iconPath: new ThemeIcon('folder'),
        },
        {
            label: '',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: Interpreter.createVirtualEnvironment,
            iconPath: new ThemeIcon('add'),
        },
    ];

    if (options?.recommended) {
        const pathDescription = options.recommended.displayPath;
        const description =
            options.recommended.description && options.recommended.description.trim()
                ? `${options.recommended.description} (${pathDescription})`
                : pathDescription;

        staticItems.push(
            {
                label: Common.recommended,
                kind: QuickPickItemKind.Separator,
            },
            {
                label: options.recommended.displayName,
                description: description,
                result: options.recommended,
                iconPath: getIconPath(options.recommended.iconPath),
            },
        );
    }

    // Sections are stored per manager and rebuilt into the final list in a fixed manager order,
    // independent of the order in which managers finish loading. This keeps section ordering
    // deterministic while environments stream in.
    const sections = new Map<string, ManagerSection>();

    const buildItems = (): EnvironmentPickItem[] => {
        const result: EnvironmentPickItem[] = [...staticItems];
        const seen = new Set<string>();
        // The recommended environment is already shown above; skip it in the manager sections.
        if (options?.recommended) {
            seen.add(environmentIdentityKey(options.recommended));
        }
        for (const manager of managers) {
            const section = sections.get(manager.id);
            if (!section) {
                continue;
            }
            const visible: EnvironmentQuickPickItem[] = [];
            for (const entry of section.entries) {
                if (seen.has(entry.key)) {
                    continue;
                }
                seen.add(entry.key);
                visible.push(entry.item);
            }
            if (visible.length > 0) {
                result.push(section.separator, ...visible);
            }
        }
        return result;
    };

    const onDidShow = (controller: QuickPickController<EnvironmentPickItem>) => {
        controller.setBusy(true);
        const loads = managers.map(async (manager) => {
            try {
                const envs = await manager.getEnvironments('all');
                const entries: { key: string; item: EnvironmentQuickPickItem }[] = [];
                const localKeys = new Set<string>();
                for (const e of envs) {
                    const key = environmentIdentityKey(e);
                    if (localKeys.has(key)) {
                        continue;
                    }
                    localKeys.add(key);
                    entries.push({ key, item: createEnvironmentItem(e, manager) });
                }
                sections.set(manager.id, {
                    separator: {
                        label: manager.displayName,
                        kind: QuickPickItemKind.Separator,
                    },
                    entries,
                });
            } catch (err) {
                traceError(
                    `[pickEnvironment] Failed to load environments for manager "${manager.id}"; section skipped.`,
                    err,
                );
            }
            // Stream whatever has loaded so far; no-ops if the picker has already been closed.
            controller.setItems(buildItems());
        });

        void Promise.allSettled(loads).finally(() => controller.setBusy(false));
    };

    return pickEnvironmentImpl(staticItems, managers, projectEnvManagers, options, onDidShow);
}

export async function pickEnvironmentFrom(environments: PythonEnvironment[]): Promise<PythonEnvironment | undefined> {
    const items = environments.map((e) => {
        const pathDescription = e.displayPath;
        const description =
            e.description && e.description.trim() ? `${e.description} (${pathDescription})` : pathDescription;

        return {
            label: e.displayName ?? e.name,
            description: description,
            e: e,
            iconPath: getIconPath(e.iconPath),
        };
    });
    const selected = await showQuickPick(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
    });
    return (selected as { e: PythonEnvironment })?.e;
}
