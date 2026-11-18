import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./worker.js', import.meta.url));

function getSystemTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

function isValidTimezone(tz) {
    if (typeof tz !== 'string' || !tz || tz === 'UTC' || tz === 'Etc/UTC') {
        return false;
    }
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function createWorkerPool({
    workers: worker_counts,
    queueSize,
    timeout,
    metrics,
    workerFactory = (env) => new Worker(file, env ? { env } : undefined)
}) {
    const workers = [];
    const queue = [];
    let stopped = false;
    const initialSystemTz = getSystemTimezone();
    const allowGeoSync = !initialSystemTz || initialSystemTz === 'UTC' || initialSystemTz === 'Etc/UTC';
    let active_tz = initialSystemTz;
    let workerTzOverride = null;

    function replaceWorkerForTimezone(item) {
        if (item.failed || stopped) return;
        item.failed = true;

        const task = item.task;
        if (task) {
            clearTimeout(task.timer);
            item.task = undefined;
            item.busy = false;
            queue.unshift(task);
        }

        const i = workers.indexOf(item);
        if (i >= 0) workers.splice(i, 1);

        try {
            item.worker.terminate();
        } catch { }

        start();
    }

    function applyTimezone(tz, triggeringItem = null) {
        if (!allowGeoSync || !isValidTimezone(tz) || active_tz === tz) {
            return false;
        }
        workerTzOverride = tz;
        active_tz = tz;
        process.env.TZ = tz;
        new Date().getTimezoneOffset();
        for (const w of [...workers]) {
            if (w.tz !== active_tz && (!w.busy || w === triggeringItem)) {
                replaceWorkerForTimezone(w);
            }
        }
        dispatch();
        return true;
    }

    function start() {
        const workerEnv = workerTzOverride ? { ...process.env, TZ: workerTzOverride } : undefined;
        const item = {
            worker: workerEnv ? workerFactory(workerEnv) : workerFactory(),
            busy: false,
            task: undefined,
            minterSession: null,
            tz: workerTzOverride || active_tz
        };

        item.worker.on('message', (msg) => {
            if (msg?.type === 'sync_tz') {
                applyTimezone(msg.tz, item);
                return;
            }

            if (!item.task) return;

            const task = item.task;

            item.task = undefined;
            item.busy = false;

            clearTimeout(task.timer);

            if (msg.type === 'success') {
                if (msg.data?.minterSession) {
                    item.minterSession = msg.data.minterSession;
                }
                task.resolve(msg.data);
            } else {
                task.reject(
                    Object.assign(new Error(msg.error?.message || 'generation failed'), {
                        code: 'GENERATION_FAILED'
                    })
                );
            }

            if (active_tz && item.tz !== active_tz && !stopped) {
                replaceWorkerForTimezone(item);
            }

            dispatch();
        });

        item.worker.on('error', (error) => fail(item, error));

        item.worker.on('exit', (c) => {
            if (c !== 0 && !stopped && !item.failed) fail(item, new Error(`worker exited with code ${c}`));
        });
        workers.push(item);
    }

    function fail(item, error) {
        if (item.failed) return;

        item.failed = true;

        if (item.task) {
            clearTimeout(item.task.timer);

            item.task.reject(error);
            item.task = undefined;
            item.busy = false;
        }
        metrics.workerFailures++;

        const i = workers.indexOf(item);

        if (i >= 0) workers.splice(i, 1);

        if (!stopped) {
            start();
            dispatch();
        }
    }

    function dispatch() {
        for (const i of workers) {
            if (i.busy && queue.length === 0) continue;

            const task = !i.busy ? queue.shift() : undefined;

            if (!task) continue;

            i.busy = true;
            i.task = task;

            task.timer = setTimeout(() => {
                i.worker.terminate();
                fail(
                    i,
                    Object.assign(new Error('generation timed out'), {
                        code: 'TIMEOUT'
                    })
                );
            }, timeout);

            i.worker.postMessage({
                contentBinding: task.contentBinding,
                visitorTtl: task.visitorTtl,
                ttl: task.ttl,
                requestTimeout: task.requestTimeout
            });
        }
    }

    for (let i = 0; i < worker_counts; i++) start();

    return {
        run(contentBinding, visitorTtl, requestTimeout, ttl) {
            if (stopped) return Promise.reject(new Error('worker pool is stopped'));

            if (queue.length >= queueSize && !workers.some((item) => !item.busy))
                return Promise.reject(Object.assign(new Error('generation queue is full'), { code: 'QUEUE_FULL' }));

            return new Promise((resolve, reject) => {
                queue.push({ contentBinding, visitorTtl, requestTimeout, ttl, resolve, reject });
                metrics.queued++;
                dispatch();
            });
        },
        stats() {
            return {
                workers: workers.length,
                active: workers.filter((item) => item.busy).length,
                queue: queue.length
            };
        },
        setTimezone(tz) {
            return applyTimezone(tz, null);
        },
        invalidate(minterSession = null) {
            for (const item of workers) {
                if (minterSession && item.minterSession !== minterSession) {
                    continue;
                }
                item.minterSession = null;
                try {
                    item.worker.postMessage({ type: 'invalidate', minterSession });
                } catch { }
            }
        },
        async close() {
            stopped = true;
            for (const task of queue.splice(0)) task.reject(new Error('worker pool is stopping'));
            await Promise.all(workers.map((item) => item.worker.terminate()));
        }
    };
}
