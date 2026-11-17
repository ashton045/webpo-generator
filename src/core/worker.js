import { parentPort } from 'node:worker_threads';
import { generate } from './generator.js';
import { resetMinter } from '../../botguard.js';
import { resetVisitorData } from './visitor.js';

parentPort.on('message', async (message) => {
    if (message?.type === 'invalidate') {
        resetMinter(message.minterSession || null);
        if (!message.minterSession) {
            resetVisitorData();
        }
        return;
    }

    const { contentBinding, visitorTtl, requestTimeout, timeout, ttl } = message;
    try {
        parentPort.postMessage({
            type: 'success',
            data: await generate(contentBinding, ttl || visitorTtl, requestTimeout ?? timeout)
        });
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            error: {
                message: error.message,
                stack: error.stack
            }
        });
    }
});
