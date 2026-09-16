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
    pendingRequests, 
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
const visitorTtl = process.env.VISITOR_TTL ? Number(process.env.VISITOR_TTL) : 10 * 60 * 1000; //10mins 
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
const maxCacheTtl = process.env.MAX_CACHE_TTL ? Number(process.env.MAX_CACHE_TTL) : 12 * 60 * 60 * 1000; //12hrs
const lrTtl = process.env.LR_TTL ? Number(process.env.LR_TTL) : 60 * 60 * 1000; //1hr for lrid
const cache = createCache(cacheSize, maxCacheTtl);
const lr_cache = createCache(cacheSize, lrTtl);
const internal_visitor_cache = createCache(cacheSize, visitorTtl);
const external_visitor_cache = createCache(cacheSize, maxCacheTtl);
let currentMinterSession = null;
const inf = new Map();
const pool = createWorkerPool({workers, queueSize, timeout: 15000, metrics});

function send(res, status, body) {

    res.writeHead(status, { 
        'Content-Type': 'application/json; charset=utf-8', 
        'Cache-Control': 'no-store' 
    });
    res.end(JSON.stringify(body));
}

function pathname(u) {
    const queryIndex = u.indexOf('?');
    return queryIndex === -1 ? u : u.slice(0, queryIndex);
}

function responseWithColdStartToken(result, tok) {
    const { minterSession, ...response } = result;
    if(tok) response.coldStartToken = createColdStartToken(result.contentBinding) || null;
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

async function generate(contentBinding, explicit_binding = false, req_ttl = null) {
    const key = typeof contentBinding === 'string' ? decodeURIComponent(contentBinding) : contentBinding;
    const isVidId = typeof key === 'string' && /^[A-Za-z0-9_-]{11}$/.test(key);
    const isLrId = typeof key === 'string' && /^[A-Za-z0-9+/_-]{11}=$/.test(key);

    let bindingCache = null;
    let cachePrefix = 'ext:';
    let defaultTtlMs = 0;

    if (isVidId) {
        bindingCache = cache;
        cachePrefix = 'v:';
        defaultTtlMs = maxCacheTtl;
    } else if (isLrId) {
        bindingCache = lr_cache;
        cachePrefix = 'lr:';
        defaultTtlMs = lrTtl;
    } else if (!explicit_binding) {
        bindingCache = internal_visitor_cache;
        cachePrefix = 'int:';
        defaultTtlMs = visitorTtl; 
    } else {
        bindingCache = external_visitor_cache;
        defaultTtlMs = maxCacheTtl;
    }

    const k = cachePrefix + key;

    if (bindingCache) {
        const cached = bindingCache.get(key);
        if (cached) { 
            metrics.cacheHits++; 
            record_cache('hit'); 
            return cached; 
        }
    }

    metrics.cacheMisses++;
    record_cache('miss');

    if (inf.has(k)) return inf.get(k);

    const started = Date.now();
    const taskTtl = req_ttl || (isVidId ? null : (defaultTtlMs > 0 ? defaultTtlMs : null));

    const promise = pool.run(contentBinding, taskTtl, 15000, taskTtl).then((value) => {
        metrics.successes++;
        metrics.generationMs += Date.now() - started;
        metrics.generations++;
        record('success');

        if (value) {
            if (value.minterSession) {
                if (currentMinterSession && value.minterSession !== currentMinterSession) {
                    cache.clear();
                    lr_cache.clear();
                    external_visitor_cache.clear();
                }
                currentMinterSession = value.minterSession;
            }

            if (bindingCache) {
                let ttl_ms;
                if (isVidId || explicit_binding) {
                    ttl_ms = req_ttl 
                        ? (value.ttl ? Math.min(req_ttl, value.ttl * 1000) : req_ttl)
                        : (value.ttl ? value.ttl * 1000 : maxCacheTtl);
                } else {
                    ttl_ms = taskTtl || defaultTtlMs;
                    if (value.ttl) {
                        ttl_ms = Math.min(ttl_ms, value.ttl * 1000);
                    }
                }

                if (ttl_ms > 5000) {
                    bindingCache.set(key, value, ttl_ms);
                }
            }
        }

        return value;
    }).finally(() => inf.delete(k));
    
    inf.set(k, promise);

    return promise;
}

async function handle(req, res) {
    metrics.requests++;

    const path = pathname(req.url);

    if(path === '/' && req.method === 'GET') 
        return send(res, 200, { name: 'webpo-generator', endpoints: ['/generate', '/decode_cold_start', '/health', '/ready', '/metrics', '/metrics/json'] });

    if(path === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });

    if(!isAuthorized(req, token))
        return send(res, 401, { error: 'unauthorized' });

    if(path === '/ready' && req.method === 'GET') 
        return send(res, pool.stats().workers > 0 ? 200 : 503, { status: pool.stats().workers > 0 ? 'ready' : 'unavailable', ...pool.stats() });

    if(path === '/metrics' && req.method === 'GET') {

        setStats({ ...metrics, ...pool.stats() });

        res.writeHead(200, { 
            'Content-Type': metricsContentType, 
            'Cache-Control': 'no-store' 
        });
        res.end(await text());
        return;
    }

    if(path === '/metrics/json' && req.method === 'GET') 
        return send(res, 200, { 
            ...metrics, 
            cacheSize: cache.size + lr_cache.size + internal_visitor_cache.size + external_visitor_cache.size, 
            inFlight: inf.size, 
            ...pool.stats() 
        });

    if(path === '/decode_cold_start' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const err = validateColdStartDecode(body);

            if(err) return send(res, 400, { error: err });

            return send(res, 200, decodeColdStartToken(body.token));
        } catch (error) {
            return send(res, 400, { error: error.message || 'invalid coldStarToken' });
        }
    }
    
    if(path !== '/generate' || req.method !== 'POST') 
        return send(res, 404, { error: 'not found' });

    if(metrics.pendingRequests >= maxPendingRequests)
        return send(res, 503, { error: 'service overloaded' });

    metrics.pendingRequests++;
    pendingRequests.set(metrics.pendingRequests);

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
            const explicit_binding = typeof body.content_binding === 'string' && body.content_binding.trim().length > 0;
            const contentBinding = explicit_binding ? body.content_binding.trim() : await getVisitorData(visitorTtl, 30000);
            const req_ttl = Number.isFinite(body.ttl) && body.ttl > 0 ? body.ttl * 1000 : null;

            return send(res, 200, responseWithColdStartToken(
                await generate(contentBinding, explicit_binding, req_ttl), 
                body.coldToken === true
            ));
        } catch (error) {
            metrics.failures++;
            record('error');
            console.error(`WebPO generation failed: ${error.message}`);

            const status = error.code === 'QUEUE_FULL' ? 503 : error.code === 'TIMEOUT' ? 504 : 500;

            return send(res, status, { error: status === 503 ? 'service overloaded' : status === 504 ? 'generation timed out' : 'generation failed' });
        }
    } finally {
        metrics.pendingRequests--;

        pendingRequests.set(metrics.pendingRequests);

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
    lr_cache.close();
    internal_visitor_cache.close();
    external_visitor_cache.close();
    server.close(); 
    await pool.close(); process.exit(0); 
}
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGTERM', () => shutdown('SIGTERM'));
