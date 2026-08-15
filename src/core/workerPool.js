import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./worker.js', import.meta.url));

export function createWorkerPool({ workers: worker_counts, queueSize, timeout, metrics }) {
    const workers = [];
    const queue = [];
    let stopped = false;

    function start() {

        const item = { 
            worker: new Worker(file), 
            busy: false, 
            task: undefined 
        };

        item.worker.on('message', (msg) => {
            if(!item.task) return;

            const task = item.task;

            item.task = undefined;
            item.busy = false;

            clearTimeout(task.timer);

            if(msg.type === 'success')
                task.resolve(msg.data);
            else
                task.reject(Object.assign(new Error(msg.error?.message || 'generation failed'), {
                    code: 'GENERATION_FAILED'
                }));

            dispatch();
        });

        item.worker.on('error', (error) => fail(item, error));
        
        item.worker.on('exit', (c) => { 
            if(c !== 0 && !stopped && !item.failed) 
                fail(item, new Error(`worker exited with code ${c}`)); 
        });
        workers.push(item);
    }

    function fail(item, error) {
        if(item.failed) return;

        item.failed = true;

        if(item.task) {
            clearTimeout(item.task.timer);

            item.task.reject(error);
            item.task = undefined; item.busy = false;
        }
        metrics.workerFailures++;

        const i = workers.indexOf(item);

        if(i >= 0)
            workers.splice(i, 1);

        if(!stopped) {
            start();
            dispatch();
        }
    }

    function dispatch() {

        for(const i of workers) {
            
            if(i.busy && queue.length === 0)
                continue;

            const task = !i.busy ? queue.shift() : undefined;

            if(!task) continue;

            i.busy = true;
            i.task = task;

            task.timer = setTimeout(() => {
                
                i.worker.terminate();
                fail(i, Object.assign(new Error('generation timed out'), {
                    code: 'TIMEOUT'
                }));
                
                }, timeout);

            i.worker.postMessage({ 
                contentBinding: task.contentBinding, 
                visitorTtl: task.visitorTtl, 
                requestTimeout: task.requestTimeout 
            });
        }
    }

    for(let i = 0; i < worker_counts; i++)
        start();

    return {
        run(contentBinding, visitorTtl, requestTimeout) {
            if(stopped)
                return Promise.reject(new Error('worker pool is stopped'));

            if(queue.length >= queueSize && !workers.some((item) => !item.busy))
                return Promise.reject(Object.assign(new Error('generation queue is full'), { code: 'QUEUE_FULL' }));

            return new Promise((resolve, reject) =>{
                queue.push({ contentBinding, visitorTtl, requestTimeout, resolve, reject });
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
        async close() {
            stopped = true;
            for(const task of queue.splice(0))
                task.reject(new Error('worker pool is stopping'));
            await Promise.all(workers.map((item) => item.worker.terminate()));
        }
    };
}
