// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeActionKind,
    CodeActionProvider,
    Diagnostic,
    Disposable,
    languages,
    Range,
    TextDocument,
} from 'vscode';
import { MAX_HEADER_BYTES, readInlineScriptMetadata } from '../../common/inlineScript/metadata';
import { getInlineScriptRoutingKey, InlineScriptRoutingRegistry } from '../../common/inlineScript/routingRegistry';
import { InlineScriptStrings } from '../../common/localize';
import { InlineScriptSetupTrigger } from '../../common/telemetry/constants';
import { isInlineScriptsFeatureEnabled } from '../../helpers';

/**
 * Diagnostic codes that mean "this import did not resolve", across every type checker a user of this
 * extension is likely to have enabled. Stored lowercased; compare with {@link normalizeDiagnosticCode}.
 *
 * Matching is on `code` only, never on `source`: Pyrefly-backed Pylance reports its source as the
 * literal string `pylance + pyrefly`, so any source allow-list would be wrong somewhere.
 *
 * `reportMissingModuleSource` is included deliberately, diverging from Pylance's own
 * `isMissingImportDiagnostic`, which excludes it because a stub-resolved module is correctly spelled
 * and so has nothing for a "change spelling" fix to suggest. For us the meaning is the opposite kind
 * of useful: a stub was found but the source was not, i.e. the package is not installed — which is
 * exactly what setting the script's environment up addresses.
 */
const UNRESOLVED_IMPORT_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
    // Pyright / Pylance / basedpyright.
    'reportmissingimports',
    'reportmissingmodulesource',
    // Ty (kebab-case), mapped to the two rules above by Pylance's TyDiagnosticCodeMapper.
    'unresolved-import',
    'possibly-missing-import',
    // Pyrefly (kebab-case `ErrorKind` names), mapped by Pylance's PyreflyDiagnosticCodeMapper.
    'missing-import',
    'missing-source',
    'missing-source-for-stubs',
    // mypy, via the separate ms-python.mypy-type-checker extension.
    'import-not-found',
    'import-untyped',
]);

/**
 * Reduce `Diagnostic.code` — which is `string | number | { value: string | number; target: Uri }` —
 * to a lowercased string, or `undefined` when the diagnostic carries no code.
 */
function normalizeDiagnosticCode(code: Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) {
        return undefined;
    }
    const value = typeof code === 'object' ? code.value : code;
    return typeof value === 'string' || typeof value === 'number' ? String(value).toLowerCase() : undefined;
}

/**
 * Whether `diagnostic` reports an import that could not be resolved. See
 * {@link UNRESOLVED_IMPORT_DIAGNOSTIC_CODES} for the dialects covered and for why `source` is ignored.
 */
export function isUnresolvedImportDiagnostic(diagnostic: Diagnostic): boolean {
    const code = normalizeDiagnosticCode(diagnostic.code);
    return code !== undefined && UNRESOLVED_IMPORT_DIAGNOSTIC_CODES.has(code);
}

/**
 * The head of `document`'s in-memory text, bounded to the same byte budget that
 * `readInlineScriptMetadataFromFile` reads from disk.
 *
 * Bounding it matters twice over: it keeps this provider's work constant regardless of file size,
 * and it keeps what the quick fix can see identical to what setup will later parse off disk, so the
 * action is never offered for a block that setup would not find.
 */
function getInlineScriptHeaderText(document: TextDocument): string {
    const text = document.getText();
    if (Buffer.byteLength(text, 'utf-8') <= MAX_HEADER_BYTES) {
        return text;
    }
    // Truncating on a byte boundary can split a multi-byte character; the disk reader's bounded
    // `read` has exactly the same behaviour, so the two stay in agreement.
    return Buffer.from(text, 'utf-8').subarray(0, MAX_HEADER_BYTES).toString('utf-8');
}

/**
 * Offers "Set up this script's Python environment" as a quick fix on an unresolved import in a `.py`
 * file that declares a PEP 723 `# /// script` block and has no inline-script environment yet.
 *
 * This exists because the CodeLens is the feature's only other entry point and `provideCodeLenses`
 * returns nothing while `document.isDirty` — so it is absent at the one moment a user most needs it,
 * right after typing `import requests` and seeing the squiggle. This provider parses the in-memory
 * buffer instead, so it works on an unsaved edit.
 *
 * Deliberate non-promises, both in wording and in mechanics:
 *  - the title says what the action does, not that the squiggle will clear — the unresolved module
 *    may be undeclared in the block, or declared under a different distribution name (`PIL` vs
 *    `pillow`);
 *  - `diagnostics` is left unset, because populating it would tell VS Code this action *resolves*
 *    those diagnostics and would opt it into fix-all affordances;
 *  - `isPreferred` is left unset, so it never pre-empts a real import fix such as "add import".
 *
 * The action disappears once the script is set up (`shouldRoute`) and comes back by itself if the
 * user later edits the metadata block, because a changed metadata identity resets the registry's
 * validated association.
 */
export class InlineScriptSetupCodeActionProvider implements CodeActionProvider {
    constructor(
        private readonly routing: InlineScriptRoutingRegistry,
        private readonly setupCommand: string,
    ) {}

    /**
     * Gates are ordered cheapest-first because VS Code may call this on every cursor move. The
     * `context.diagnostics` test comes before any parsing: the common case is a file with no
     * unresolved import at the cursor, and that case must cost nothing but a short array scan.
     */
    public provideCodeActions(
        document: TextDocument,
        _range: Range,
        context: CodeActionContext,
        _token: CancellationToken,
    ): CodeAction[] {
        if (!isInlineScriptsFeatureEnabled()) {
            return [];
        }
        if (!context.diagnostics.some(isUnresolvedImportDiagnostic)) {
            return [];
        }
        const uri = document.uri;
        if (!getInlineScriptRoutingKey(uri)) {
            // Not a local `.py` file, so it can never carry an inline-script environment.
            return [];
        }
        if (this.routing.shouldRoute(uri)) {
            // A validated inline-script environment matching the current metadata already exists.
            return [];
        }
        if (!readInlineScriptMetadata(getInlineScriptHeaderText(document), uri.fsPath)) {
            return [];
        }
        const action = new CodeAction(InlineScriptStrings.setUpScriptEnvironment, CodeActionKind.QuickFix);
        const trigger: InlineScriptSetupTrigger = 'codeaction';
        action.command = {
            title: InlineScriptStrings.setUpScriptEnvironment,
            command: this.setupCommand,
            arguments: [uri, trigger],
        };
        return [action];
    }
}

/**
 * Register the inline-script quick fix for local `.py` files. Only called when the PEP 723
 * inline-script feature flag is enabled, so it is a no-op for everyone else.
 */
export function registerInlineScriptSetupCodeAction(
    routing: InlineScriptRoutingRegistry,
    setupCommand: string,
): Disposable {
    return languages.registerCodeActionsProvider(
        { scheme: 'file', language: 'python' },
        new InlineScriptSetupCodeActionProvider(routing, setupCommand),
        { providedCodeActionKinds: [CodeActionKind.QuickFix] },
    );
}
