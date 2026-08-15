import { parentPort } from 'node:worker_threads';
import { generate } from './generator.js';

parentPort.on('message', async ({ contentBinding, visitorTtl, requestTimeout }) => {
    try {
        parentPort.postMessage({ type: 'success', data: await generate(contentBinding, visitorTtl, requestTimeout)
        });
    }
    catch (error) {
        parentPort.postMessage({
            type: 'error',
            error: {
                message: error.message,
                stack: error.stack
            }
        });
    }
});
