import * as os from 'os';
import * as path from 'path';
import { NotebookCell, NotebookDocument, Uri, workspace } from 'vscode';
import { isWindows } from './platformUtils';

export function checkUri(scope?: Uri | Uri[] | string): Uri | Uri[] | string | undefined {
    if (!scope) {
        return undefined;
    }

    if (Array.isArray(scope)) {
        // if the scope is an array, all items must be Uri, check each item
        return scope.map((item) => {
            const s = checkUri(item);
            if (s instanceof Uri) {
                return s;
            }
            throw new Error('Invalid entry, expected Uri.');
        });
    }

    if (scope instanceof Uri) {
        if (scope.scheme === 'vscode-notebook-cell') {
            const matchingDoc = workspace.notebookDocuments.find((doc) => findCell(scope, doc));
            // If we find a matching notebook document, return the Uri of the cell.
            return matchingDoc ? matchingDoc.uri : scope;
        }
    }
    return scope;
}

/**
 * Find a notebook document by cell Uri.
 */
export function findCell(cellUri: Uri, notebook: NotebookDocument): NotebookCell | undefined {
    // Fragment is not unique to a notebook, hence ensure we compare the path as well.
    return notebook.getCells().find((cell) => {
        return isEqual(cell.document.uri, cellUri);
    });
}
function isEqual(uri1: Uri | undefined, uri2: Uri | undefined): boolean {
    if (uri1 === uri2) {
        return true;
    }
    if (!uri1 || !uri2) {
        return false;
    }
    return getComparisonKey(uri1) === getComparisonKey(uri2);
}

function getComparisonKey(uri: Uri): string {
    return uri
        .with({
            path: isWindows() ? uri.path.toLowerCase() : uri.path,
            fragment: undefined,
        })
        .toString();
}

export function normalizePath(fsPath: string): string {
    const path1 = fsPath.replace(/\\/g, '/');
    if (isWindows()) {
        return path1.toLowerCase();
    }
    return path1;
}

/**
 * Determines whether `candidateFsPath` is the same path as, or nested inside, `scopeFsPath`.
 *
 * Both operands are passed through {@link path.resolve} so relative segments and (on Windows)
 * drive letters are handled consistently across platforms, and {@link path.relative} is used so
 * that sibling directories which merely share a name prefix — e.g. `.../app` vs `.../app-2` — are
 * correctly treated as *outside* the scope. Containment is inclusive: when `candidateFsPath`
 * resolves to `scopeFsPath` itself the function returns `true`.
 *
 * @param scopeFsPath Container path to test against (for example a workspace folder).
 * @param candidateFsPath Path to test for containment.
 * @returns `true` when `candidateFsPath` equals or is located under `scopeFsPath`.
 */
export function isPathInside(scopeFsPath: string, candidateFsPath: string): boolean {
    const relative = path.relative(path.resolve(scopeFsPath), path.resolve(candidateFsPath));
    return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

/**
 * Produces a single, canonical key for a filesystem path suitable for identity comparisons,
 * de-duplication, and use as a map key. The path is made absolute with {@link path.resolve} (so
 * relative segments and, on Windows, drive letters are resolved consistently) and then normalized
 * with {@link normalizePath} (forward slashes everywhere, lower-cased on Windows). No filesystem
 * access is performed, so symlinks are intentionally not resolved.
 *
 * @param fsPath The filesystem path to canonicalize.
 * @returns The absolute, normalized key for the path.
 */
export function toNormalizedPathKey(fsPath: string): string {
    return normalizePath(path.resolve(fsPath));
}

export function getResourceUri(resourcePath: string, root?: string): Uri | undefined {
    try {
        if (!resourcePath) {
            return undefined;
        }

        const normalizedPath = normalizePath(resourcePath);
        if (normalizedPath.includes('://')) {
            return Uri.parse(normalizedPath);
        }

        if (!path.isAbsolute(resourcePath) && root) {
            const absolutePath = path.resolve(root, resourcePath);
            return Uri.file(absolutePath);
        }
        return Uri.file(resourcePath);
    } catch (_err) {
        return undefined;
    }
}

export function untildify(path: string): string {
    return path.replace(/^~($|\/|\\)/, `${os.homedir()}$1`);
}

export function getUserHomeDir(): string {
    return os.homedir();
}

/**
 * Applies untildify to an array of paths
 * @param paths Array of potentially tilde-containing paths
 * @returns Array of expanded paths
 */
export function untildifyArray(paths: string[]): string[] {
    return paths.map((p) => untildify(p));
}
