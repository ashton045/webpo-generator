import http from 'node:http';
import { createWorkerPool } from './src/core/workerPool.js';
import { createCache } from './src/core/cache.js';
import { getVisitorData } from './src/core/visitor.js';
import { createColdStartToken, decodeColdStartToken } from './botguard.js';
import { isAuthorized } from './src/middleware/auth.js';
import { validateColdStartDecode, validateGeneration } from './src/middleware/validation.js';
import { 
    activeWorkers, 
    metricsContentType, 
    text, 
    observe, 
    pendingRequests as pendingRequestsGauge, 
    queueDepth, 
    record_cache, 
    record, 
    setStats 
} from './src/metrics.js';

const port = process.env.PORT || 8080;
const host = process.env.HOST || '0.0.0.0';
const workers = process.env.WORKERS || 1;
const queueSize = process.env.QUEUE_SIZE || 32;
const maxPendingRequests = process.env.MAX_PENDING_REQUESTS || 256;
const cacheSize = process.env.CACHE_SIZE || 100;
const visitorTtl = process.env.VISITOR_TTL || 6 * 60 * 60 * 1000; // 6 hours
const token = process.env.API_TOKEN || '';
const metrics = { 
    requests: 0, 
    successes: 0, 
    failures: 0,
    cacheHits: 0, 
    cacheMisses: 0, 
    generationMs: 0, 
    generations: 0, 
    workerFailures: 0, 
    queued: 0, 
    pendingRequests: 0 
};
const cache = createCache(cacheSize, 150000);
const visitor_cache = createCache(cacheSize, visitorTtl);
const inf = new Map();
const pool = createWorkerPool({workers, queueSize, timeout: 15000, metrics});

function send(res, status, body) {

    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function pathname(u) {
    const queryIndex = u.indexOf('?');
    return queryIndex === -1 ? u : u.slice(0, queryIndex);
}

function responseWithColdStartToken(result, includeColdToken) {
    const response = { ...result };
    if(includeColdToken)
        response.coldStartToken = createColdStartToken(result.contentBinding) || null;
    return response;
}

function readBody(req) {

    return new Promise((resolve, reject) => {

        let data = '';
        let isLarge = false;
        let set = false;

        req.setEncoding('utf8');

        req.on('data', (chunk) => {
            if(isLarge || set) return;
            data += chunk;
            if(data.length > 1024 * 1024) {
                isLarge = true;
                req.resume();
                reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
        });

        req.on('end', () => {
            if(isLarge || set) return;
            set = true;
            try { 
                resolve(JSON.parse(data || '{}')); 
            } catch { 
                reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' })); 
            }
        });

        req.on('aborted', () => {
            if(!set && !isLarge) { 
                set = true; 
                reject(Object.assign(new Error('request aborted'), { code: 'REQUEST_ABORTED' })); 
            }
        });

        req.on('error', (error) => {
            if(!set && !isLarge) { 
                set = true; 
                reject(error); 
            }
        });
    });
}

async function generate(contentBinding, explicit_binding = false) {

    const key = contentBinding;
    const is_video = typeof contentBinding === 'string' && /^[A-Za-z0-9_-]{11}$/.test(contentBinding);
    const should_cache = is_video || !explicit_binding;
    const bindingCache = is_video ? cache : visitor_cache;

    const cached = should_cache ? bindingCache.get(key) : undefined;

    if(cached){ 
        metrics.cacheHits++; record_cache('hit'); 

        return cached; 
    }

    metrics.cacheMisses++;
    record_cache('miss');

    if(inf.has(key)) return inf.get(key);

    const started = Date.now();

    const promise = pool.run(contentBinding, 60000, 15000).then((value) => {

        metrics.successes++;
        metrics.generationMs += Date.now() - started;

        metrics.generations++;

        record('success');
        if(should_cache)
            bindingCache.set(key, value);

        return value;

    }).finally(() => inf.delete(key));
    
    inf.set(key, promise);

    return promise;
}

async function handle(req, res) {
    metrics.requests++;

    const path = pathname(req.url);

    if(path === '/' && req.method === 'GET') 
        return send(res, 200, { name: 'webpo-generator', version: '1.0.0', endpoints: ['/generate', '/generate_pot', '/decode_cold_start', '/health', '/ready', '/metrics', '/metrics/json'] });

    if(path === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });

    if(path === '/ready' && req.method === 'GET') 
        return send(res, pool.stats().workers > 0 ? 200 : 503, { status: pool.stats().workers > 0 ? 'ready' : 'unavailable', ...pool.stats() });

    if(path === '/metrics' && req.method === 'GET') {

        setStats({ ...metrics, ...pool.stats() });

        res.writeHead(200, { 'Content-Type': metricsContentType, 'Cache-Control': 'no-store' });
        res.end(await text());
        return;
    }

    if(path === '/metrics/json' && req.method === 'GET') 
        return send(res, 200, { 
            ...metrics, 
            cacheSize: cache.size, 
            inFlight: inf.size, 
            ...pool.stats() 
        });

    if(path === '/decode_cold_start' && req.method === 'POST') {
        if(!isAuthorized(req, token)) 
            return send(res, 401, { error: 'unauthorized' });

        try {
            const body = await readBody(req);
            const err = validateColdStartDecode(body);

            if(err) return send(res, 400, { error: err });

            return send(res, 200, decodeColdStartToken(body.token));
        } catch (error) {
            return send(res, 400, { error: error.message || 'invalid cold-start token' });
        }
    }
    
    if(!['/generate'].includes(path) || req.method !== 'POST') 
        return send(res, 404, { error: 'not found' });

    if(!isAuthorized(req, token))
        return send(res, 401, { error: 'unauthorized' });

    if(metrics.pendingRequests >= maxPendingRequests)
        return send(res, 503, { error: 'service overloaded' });

    metrics.pendingRequests++;
    pendingRequestsGauge.set(metrics.pendingRequests);

    try {
        let body;
        try { 
            body = await readBody(req); 
        } catch(error){
            return send(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: error.message }); 
        }
        
        const err = validateGeneration(body);

        if(err) return send(res, 400, { error: err });

        try {

        const contentBinding = body.content_binding || await getVisitorData(visitorTtl, 30000);
            return send(res, 200, responseWithColdStartToken(await generate(contentBinding, body.content_binding !== undefined), body.coldToken === true));

        } catch (error) {
            metrics.failures++;
            record('error');
            console.error(`WebPO generation failed: ${error.message}`);

            const status = error.code === 'QUEUE_FULL' ? 503 : error.code === 'TIMEOUT' ? 504 : 500;

            return send(res, status, { error: status === 503 ? 'service overloaded' : status === 504 ? 'generation timed out' : 'generation failed' });
        }
    } finally {
        metrics.pendingRequests--;

        pendingRequestsGauge.set(metrics.pendingRequests);

        const stats = pool.stats();
        queueDepth.set(stats.queued ?? 0);
        activeWorkers.set(stats.workers ?? 0);
    }
}

const server = http.createServer((req, res) => {

    const started = process.hrtime.bigint();
    const route = pathname(req.url);

    res.once('finish', () => observe(req.method, route, res.statusCode, Number(process.hrtime.bigint() - started) / 1e6));

    handle(req, res).catch(() => send(res, 500, { error: 'internal server error' }));
});

server.requestTimeout = server.headersTimeout = 15000;

function listen(host) {

    server.once('error', (error) => {
        if(host == '::') {
            console.warn(`could not listen on [::]:${port} falling back to 0.0.0.0`);
            listen('0.0.0.0');
        } else {
            console.error(`could not listen on ${host}:${port}: ${error.message}`);
            process.exit(1);
        }

    });

    const addr = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    server.listen({ host, port }, () => {
        console.log(`api listening on http://${addr}:${port} with ${workers} worker(s)`);
    });
}

listen(host);

async function shutdown(signal) { 
    console.log(`${signal}: shutting down`); 
    cache.close(); 
    visitor_cache.close();
    server.close(); 
    await pool.close(); process.exit(0); 
}
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGTERM', () => shutdown('SIGTERM'));
