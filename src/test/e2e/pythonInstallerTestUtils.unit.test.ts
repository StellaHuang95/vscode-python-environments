// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as sinon from 'sinon';
import { PassThrough } from 'stream';
import { PythonProcess } from '../../api';
import { collectPythonOutput } from './pythonInstallerTestUtils';

suite('Installer fixture process output', () => {
    let stdout: PassThrough;
    let stderr: PassThrough;
    let stdin: PassThrough;
    let exit: (code: number | null, signal: NodeJS.Signals | null) => void;
    let kill: sinon.SinonSpy;
    let child: PythonProcess;

    setup(() => {
        stdout = new PassThrough();
        stderr = new PassThrough();
        stdin = new PassThrough();
        kill = sinon.spy();
        child = {
            stdout, stderr, stdin, kill,
            onExit: (listener) => { exit = listener; },
        };
    });

    teardown(() => {
        stdout.destroy();
        stderr.destroy();
        stdin.destroy();
        sinon.restore();
    });

    test('waits for both streams and includes output arriving after exit', async () => {
        let resolved = false;
        const output = collectPythonOutput(child).then((text) => {
            resolved = true;
            return text;
        });
        stdout.write('{"value":');
        exit(0, null);
        await Promise.resolve();
        assert.strictEqual(resolved, false);
        stdout.end('723}');
        await Promise.resolve();
        assert.strictEqual(resolved, false, 'stderr must finish too');
        stderr.end();

        assert.deepStrictEqual(JSON.parse(await output), { value: 723 });
        sinon.assert.notCalled(kill);
        assert.strictEqual(stdout.listenerCount('data'), 0);
        assert.strictEqual(stderr.listenerCount('data'), 0);
    });

    test('preserves UTF-8 split across chunks', async () => {
        const output = collectPythonOutput(child);
        const character = Buffer.from(String.fromCodePoint(0x1f40d));
        stdout.write(character.subarray(0, 2));
        stdout.end(character.subarray(2));
        stderr.end();
        exit(0, null);
        assert.strictEqual(await output, String.fromCodePoint(0x1f40d));
    });

    test('retains late stderr when reporting a nonzero exit', async () => {
        const checked = assert.rejects(collectPythonOutput(child), /late diagnostic/);
        exit(1, null);
        stdout.end();
        stderr.end('late diagnostic');
        await checked;
        sinon.assert.notCalled(kill);
    });

    for (const completedStage of ['exit', 'streams'] as const) {
        test(`bounds a process that completes only ${completedStage}`, async () => {
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const checked = assert.rejects(collectPythonOutput(child, 1000), /timed out/);
            if (completedStage === 'exit') {
                exit(0, null);
            } else {
                stdout.end();
                stderr.end();
            }
            await clock.tickAsync(1000);
            await checked;
            sinon.assert.calledOnce(kill);
            assert.strictEqual(clock.countTimers(), 0);
            assert.strictEqual(stdout.listenerCount('data'), 0);
        });
    }

    test('rejects a stream error and terminates the owned child', async () => {
        const checked = assert.rejects(collectPythonOutput(child), /broken stream/);
        stdout.destroy(new Error('broken stream'));
        stderr.end();
        await checked;
        sinon.assert.calledOnce(kill);
    });
});
