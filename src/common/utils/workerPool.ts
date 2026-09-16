// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { traceError } from '../logging';
import { createDeferred, Deferred } from './deferred';

/** Rejects a queued work item that expired before a worker could dequeue it. */
export class QueueTaskExpiredError extends Error {
    constructor(expiresInMs: number) {
        super(`Queued task expired after ${expiresInMs}ms before it could start`);
        this.name = this.constructor.name;
    }
}

interface Worker {
    /**
     * Start processing of items.
     * @method stop
     */
    start(): void;
    /**
     * Stops any further processing of items.
     * @method stop
     */
    stop(): void;
}

type NextFunc<T> = () => Promise<T>;
type WorkFunc<T, R> = (item: T) => Promise<R>;
type PostResult<T, R> = (item: T, result?: R, err?: Error) => void;

interface IWorkItem<T> {
    item: T;
    running: boolean;
    expired: boolean;
    expiryTimer?: ReturnType<typeof setTimeout>;
    expiresAt?: number;
    expiresInMs?: number;
}

export type QueueClock = () => number;

export enum QueuePosition {
    back,
    front,
}

export interface WorkerPool<T, R> extends Worker {
    /**
     * Add items to be processed to a queue.
     * @method addToQueue
     * @param {T} item: Item to process
     * @param {QueuePosition} position: Add items to the front or back of the queue.
     * @param {number} expiresAt: Optional absolute deadline on the pool's clock. A still-queued item
     *        is rejected with {@link QueueTaskExpiredError} once the clock reaches it and never runs;
     *        omit to queue unbounded.
     * @returns A promise that when resolved gets the result from running the worker function.
     */
    addToQueue(item: T, position?: QueuePosition, expiresAt?: number): Promise<R>;
}

class WorkerImpl<T, R> implements Worker {
    private stopProcessing: boolean = false;
    public constructor(
        private readonly next: NextFunc<T>,
        private readonly workFunc: WorkFunc<T, R>,
        private readonly postResult: PostResult<T, R>,
        private readonly name: string,
    ) {}
    public stop() {
        this.stopProcessing = true;
    }

    public async start() {
        while (!this.stopProcessing) {
            try {
                const workItem = await this.next();
                try {
                    const result = await this.workFunc(workItem);
                    this.postResult(workItem, result);
                } catch (ex) {
                    this.postResult(workItem, undefined, ex as Error);
                }
            } catch (ex) {
                // Next got rejected. Likely worker pool is shutting down.
                // continue here and worker will exit if the worker pool is shutting down.
                traceError(`Error while running worker[${this.name}].`, ex);
                continue;
            }
        }
    }
}

class WorkQueue<T, R> {
    private readonly items: IWorkItem<T>[] = [];
    private readonly results: Map<IWorkItem<T>, Deferred<R>> = new Map();

    public constructor(private readonly now: QueueClock = Date.now) {}

    public add(item: T, position?: QueuePosition, expiresAt?: number): Promise<R> {
        // Wrap the user provided item in a wrapper object. This will allow us to track multiple
        // submissions of the same item. For example, addToQueue(2), addToQueue(2). If we did not
        // wrap this, then from the map both submissions will look the same. Since this is a generic
        // worker pool, we do not know if we can resolve both using the same promise. So, a better
        // approach is to ensure each gets a unique promise, and let the worker function figure out
        // how to handle repeat submissions.
        const workItem: IWorkItem<T> = { item, running: false, expired: false };
        if (position === QueuePosition.front) {
            this.items.unshift(workItem);
        } else {
            this.items.push(workItem);
        }

        // This is the promise that will be resolved when the work
        // item is complete. We save this in a map to resolve when
        // the worker finishes and posts the result.
        const deferred = createDeferred<R>();
        this.results.set(workItem, deferred);

        if (expiresAt !== undefined) {
            const remainingMs = Math.max(0, expiresAt - this.now());
            workItem.expiresAt = expiresAt;
            workItem.expiresInMs = remainingMs;
            workItem.expiryTimer = setTimeout(() => this.expire(workItem), remainingMs);
        }

        return deferred.promise;
    }

    private clearExpiry(workItem: IWorkItem<T>): void {
        if (workItem.expiryTimer !== undefined) {
            clearTimeout(workItem.expiryTimer);
            workItem.expiryTimer = undefined;
        }
    }

    private settleExpired(workItem: IWorkItem<T>): void {
        this.clearExpiry(workItem);
        if (workItem.running || workItem.expired) {
            return;
        }
        workItem.expired = true;
        const deferred = this.results.get(workItem);
        if (deferred !== undefined) {
            this.results.delete(workItem);
            deferred.reject(new QueueTaskExpiredError(workItem.expiresInMs ?? 0));
        }
    }

    private expire(workItem: IWorkItem<T>): void {
        this.clearExpiry(workItem);
        if (workItem.running || workItem.expired) {
            return;
        }
        const index = this.items.indexOf(workItem);
        if (index < 0) {
            return;
        }
        this.items.splice(index, 1);
        this.settleExpired(workItem);
    }

    public completed(workItem: IWorkItem<T>, result?: R, error?: Error): void {
        this.clearExpiry(workItem);
        const deferred = this.results.get(workItem);
        if (deferred !== undefined) {
            this.results.delete(workItem);
            if (error !== undefined) {
                deferred.reject(error);
            } else {
                deferred.resolve(result);
            }
        }
    }

    public next(): IWorkItem<T> | undefined {
        let workItem = this.items.shift();
        while (workItem !== undefined) {
            if (workItem.expired) {
                workItem = this.items.shift();
                continue;
            }
            // Absolute-deadline recheck: never start an item past its deadline even if the timer hasn't fired.
            if (workItem.expiresAt !== undefined && this.now() >= workItem.expiresAt) {
                this.settleExpired(workItem);
                workItem = this.items.shift();
                continue;
            }
            workItem.running = true;
            this.clearExpiry(workItem);
            return workItem;
        }
        return undefined;
    }

    public clear(): void {
        this.results.forEach((v: Deferred<R>, k: IWorkItem<T>, map: Map<IWorkItem<T>, Deferred<R>>) => {
            this.clearExpiry(k);
            v.reject(Error('Queue stopped processing'));
            map.delete(k);
        });
        this.items.length = 0;
    }
}

class WorkerPoolImpl<T, R> implements WorkerPool<T, R> {
    // This collection tracks the full set of workers.
    private readonly workers: Worker[] = [];

    // A collections that holds unblock callback for each worker waiting
    // for a work item when the queue is empty
    private readonly waitingWorkersUnblockQueue: { unblock(w: IWorkItem<T>): void; stop(): void }[] = [];

    // A collection that manages the work items.
    private readonly queue: WorkQueue<T, R>;

    // State of the pool manages via stop(), start()
    private stopProcessing = false;

    public constructor(
        private readonly workerFunc: WorkFunc<T, R>,
        private readonly numWorkers: number = 2,
        private readonly name: string = 'Worker',
        now?: QueueClock,
    ) {
        this.queue = new WorkQueue<T, R>(now);
    }

    public addToQueue(item: T, position?: QueuePosition, expiresAt?: number): Promise<R> {
        if (this.stopProcessing) {
            throw Error('Queue is stopped');
        }

        // This promise when resolved should return the processed result of the item
        // being added to the queue.
        const deferred = this.queue.add(item, position, expiresAt);

        const worker = this.waitingWorkersUnblockQueue.shift();
        if (worker) {
            const workItem = this.queue.next();
            if (workItem !== undefined) {
                // If we are here it means there were no items to process in the queue.
                // At least one worker is free and waiting for a work item. Call 'unblock'
                // and give the worker the newly added item.
                worker.unblock(workItem);
            } else {
                // next() dropped the just-added item as already expired; re-park the worker.
                this.waitingWorkersUnblockQueue.unshift(worker);
            }
        }

        return deferred;
    }

    public start() {
        this.stopProcessing = false;
        let num = this.numWorkers;
        while (num > 0) {
            this.workers.push(
                new WorkerImpl<IWorkItem<T>, R>(
                    () => this.nextWorkItem(),
                    (workItem: IWorkItem<T>) => this.workerFunc(workItem.item),
                    (workItem: IWorkItem<T>, result?: R, error?: Error) =>
                        this.queue.completed(workItem, result, error),
                    `${this.name} ${num}`,
                ),
            );
            num = num - 1;
        }
        this.workers.forEach(async (w) => w.start());
    }

    public stop(): void {
        this.stopProcessing = true;

        // Signal all registered workers with this worker pool to stop processing.
        // Workers should complete the task they are currently doing.
        let worker = this.workers.shift();
        while (worker) {
            worker.stop();
            worker = this.workers.shift();
        }

        // Remove items from queue.
        this.queue.clear();

        // This is necessary to exit any worker that is waiting for an item.
        // If we don't unblock here then the worker just remains blocked
        // forever.
        let blockedWorker = this.waitingWorkersUnblockQueue.shift();
        while (blockedWorker) {
            blockedWorker.stop();
            blockedWorker = this.waitingWorkersUnblockQueue.shift();
        }
    }

    public nextWorkItem(): Promise<IWorkItem<T>> {
        // Note that next() will return `undefined` if the queue is empty.
        const nextWorkItem = this.queue.next();
        if (nextWorkItem !== undefined) {
            return Promise.resolve(nextWorkItem);
        }

        // Queue is Empty, so return a promise that will be resolved when
        // new items are added to the queue.
        return new Promise<IWorkItem<T>>((resolve, reject) => {
            this.waitingWorkersUnblockQueue.push({
                unblock: (workItem: IWorkItem<T>) => {
                    // This will be called to unblock any worker waiting for items.
                    if (this.stopProcessing) {
                        // We should reject here since the processing should be stopped.
                        reject();
                    }
                    // If we are here, the queue received a new work item. Resolve with that item.
                    resolve(workItem);
                },
                stop: () => {
                    reject();
                },
            });
        });
    }
}

export function createRunningWorkerPool<T, R>(
    workerFunc: WorkFunc<T, R>,
    numWorkers?: number,
    name?: string,
    now?: QueueClock,
): WorkerPool<T, R> {
    const pool = new WorkerPoolImpl<T, R>(workerFunc, numWorkers, name, now);
    pool.start();
    return pool;
}
