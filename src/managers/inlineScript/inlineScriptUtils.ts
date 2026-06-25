// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as fsapi from 'fs-extra';
import { ENVS_EXTENSION_ID } from '../../common/constants';
import { getWorkspacePersistentState } from '../../common/persistentState';

/**
 * Memento key for the script-fsPath → env-fsPath map persisted across
 * sessions. Mirrors the `VENV_WORKSPACE_KEY` shape.
 */
export const INLINE_SCRIPT_ENVS_KEY = `${ENVS_EXTENSION_ID}:inlineScripts:WORKSPACE_SELECTED`;

/**
 * Look up the persisted env path for a given inline script. Returns
 * `undefined` when no binding exists or when the bound env directory has
 * been deleted on disk; in the latter case the stale memento entry is
 * cleared so the next call short-circuits.
 */
export async function getInlineScriptEnvForScript(scriptFsPath: string): Promise<string | undefined> {
    try {
        const state = await getWorkspacePersistentState();
        const data: { [key: string]: string } | undefined = await state.get(INLINE_SCRIPT_ENVS_KEY);
        if (!data) {
            return undefined;
        }
        const envPath = data[scriptFsPath];
        if (envPath && (await fsapi.pathExists(envPath))) {
            return envPath;
        }
        if (envPath) {
            await setInlineScriptEnvForScript(scriptFsPath, undefined);
        }
    } catch {
        // Persistent state failures should never crash the caller; treat as no binding.
    }
    return undefined;
}

/**
 * Persist (or remove when `envPath` is `undefined`) the binding from a
 * script's fsPath to its inline-script env's fsPath.
 */
export async function setInlineScriptEnvForScript(scriptFsPath: string, envPath: string | undefined): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(INLINE_SCRIPT_ENVS_KEY)) ?? {};
    if (envPath) {
        data[scriptFsPath] = envPath;
    } else {
        delete data[scriptFsPath];
    }
    await state.set(INLINE_SCRIPT_ENVS_KEY, data);
}

/**
 * Batch variant of {@link setInlineScriptEnvForScript}. Writes the
 * memento exactly once for `fsPaths.length` updates.
 */
export async function setInlineScriptEnvsForScripts(
    scriptFsPaths: string[],
    envPath: string | undefined,
): Promise<void> {
    const state = await getWorkspacePersistentState();
    const data: { [key: string]: string } = (await state.get(INLINE_SCRIPT_ENVS_KEY)) ?? {};
    for (const fsPath of scriptFsPaths) {
        if (envPath) {
            data[fsPath] = envPath;
        } else {
            delete data[fsPath];
        }
    }
    await state.set(INLINE_SCRIPT_ENVS_KEY, data);
}

/**
 * Drop the entire inline-script persistence bucket. Used by the Clear
 * Script Environment Cache command (later PR).
 */
export async function clearInlineScriptEnvCache(): Promise<void> {
    const state = await getWorkspacePersistentState();
    await state.clear([INLINE_SCRIPT_ENVS_KEY]);
}
