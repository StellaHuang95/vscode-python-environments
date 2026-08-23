// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export class vscMockTelemetryReporter {
    public sendTelemetryEvent(): void {
        // Noop.
    }
    public sendTelemetryErrorEvent(): void {
        // Noop.
    }
    public sendDangerousTelemetryEvent(): void {
        // Noop.
    }
    public dispose(): Promise<void> {
        return Promise.resolve();
    }
}
