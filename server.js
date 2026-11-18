import http from 'node:http';
import { createWorkerPool } from './src/core/workerPool.js';
import { createCache } from './src/core/cache.js';
import { getVisitorData, getVisitorSession, resetVisitorData } from './src/core/visitor.js';
import { createColdStartToken, decodeColdStartToken } from './src/utils/coldStart.js';
import { resolveTimezoneForCountry } from './src/utils/timezone.js';
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
const workers = Number(process.env.WORKERS) || 1;
const queueSize = Number(process.env.QUEUE_SIZE) || 32;
const maxPendingRequests = Number(process.env.MAX_PENDING_REQUESTS) || 256;
const cacheSize = Number(process.env.CACHE_SIZE) || 100;
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
const maxCacheTtl = process.env.MAX_CACHE_TTL ? Number(process.env.MAX_CACHE_TTL) : 6 * 60 * 60 * 1000; //6hrs
const lrTtl = process.env.LR_TTL ? Number(process.env.LR_TTL) : 60 * 60 * 1000; //1hr for lrid
const cache = createCache(cacheSize, maxCacheTtl);
const lr_cache = createCache(cacheSize, lrTtl);
const internal_visitor_cache = createCache(cacheSize, visitorTtl);
const maxRecentTokens = Math.max(cacheSize * 2, 500);
const recent_tokens = new Map();
let current_minter_session = null;
const inf = new Map();
const pool = createWorkerPool({ workers, queueSize, timeout: 15000, metrics });

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
    const { minterSession: _, ...response } = result;
    if (tok) response.coldStartToken = createColdStartToken(result.contentBinding) || null;
    return response;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let isLarge = false;
        let set = false;

        req.setEncoding('utf8');

        req.on('data', (chunk) => {
            if (isLarge || set) return;
            data += chunk;
            if (data.length > 1024 * 1024) {
                isLarge = true;
                req.resume();
                reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
            }
        });

        req.on('end', () => {
            if (isLarge || set) return;
            set = true;
            try {
                resolve(JSON.parse(data || '{}'));
            } catch {
                reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' }));
            }
        });

        req.on('aborted', () => {
            if (!set && !isLarge) {
                set = true;
                reject(Object.assign(new Error('request aborted'), { code: 'REQUEST_ABORTED' }));
            }
        });

        req.on('error', (error) => {
            if (!set && !isLarge) {
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
    const taskTtl = req_ttl || (isVidId ? null : defaultTtlMs > 0 ? defaultTtlMs : null);

    const promise = pool
        .run(contentBinding, taskTtl, 15000, taskTtl)
        .then((value) => {
            metrics.successes++;
            metrics.generationMs += Date.now() - started;
            metrics.generations++;
            record('success');

            if (value) {
                if (value.minterSession) {
                    current_minter_session = value.minterSession;
                }

                if (value.poToken) {
                    recent_tokens.delete(value.poToken);
                    recent_tokens.set(value.poToken, {
                        key,
                        cache: bindingCache,
                        minterSession: value.minterSession || null,
                        isInternal: !isVidId && !isLrId && !explicit_binding
                    });
                    while (recent_tokens.size > maxRecentTokens) {
                        recent_tokens.delete(recent_tokens.keys().next().value);
                    }
                }

                if (bindingCache) {
                    let ttl_ms;
                    if (isVidId) {
                        ttl_ms = req_ttl
                            ? value.ttl
                                ? Math.min(req_ttl, value.ttl * 1000)
                                : req_ttl
                            : value.ttl
                                ? value.ttl * 1000
                                : maxCacheTtl;
                    } else if (isLrId) {
                        ttl_ms = req_ttl
                            ? value.ttl
                                ? Math.min(req_ttl, value.ttl * 1000)
                                : req_ttl
                            : value.ttl
                                ? Math.min(lrTtl, value.ttl * 1000)
                                : lrTtl;
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
        })
        .finally(() => inf.delete(k));

    inf.set(k, promise);

    return promise;
}

async function handle(req, res) {
    metrics.requests++;

    const path = pathname(req.url);

    if (path === '/' && req.method === 'GET')
        return send(res, 200, {
            name: 'webpo-generator',
            endpoints: [
                '/generate',
                '/invalidate',
                '/minter_cache',
                '/decode_cold_start',
                '/health',
                '/ready',
                '/metrics',
                '/metrics/json'
            ]
        });

    if (path === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });

    if (!isAuthorized(req, token)) return send(res, 401, { error: 'unauthorized' });

    if (path === '/invalidate' && req.method === 'POST') {
        let body = {};
        try {
            body = await readBody(req);
        } catch (error) {
            return send(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: error.message });
        }

        const poToken =
            typeof body.po_token === 'string'
                ? body.po_token.trim()
                : typeof body.poToken === 'string'
                    ? body.poToken.trim()
                    : '';
        const raw_binding =
            typeof body.content_binding === 'string'
                ? body.content_binding.trim()
                : typeof body.contentBinding === 'string'
                    ? body.contentBinding.trim()
                    : '';

        if (!poToken && !raw_binding) {
            inf.clear();
            cache.clear();
            lr_cache.clear();
            internal_visitor_cache.clear();
            recent_tokens.clear();
            current_minter_session = null;
            resetVisitorData();
            pool.invalidate();

            return send(res, 200, {
                success: true,
                message: 'all caches, visitor data, and minter sessions invalidated'
            });
        }

        let bad_session = null;
        let should_reset_visitor = false;
        let target_key = null;

        if (raw_binding) {
            try {
                target_key = decodeURIComponent(raw_binding);
            } catch {
                target_key = raw_binding;
            }
        }

        if (poToken) {
            const meta = recent_tokens.get(poToken);
            if (meta) {
                recent_tokens.delete(poToken);
                if (!target_key) target_key = meta.key;
                if (meta.minterSession) bad_session = meta.minterSession;
                if (meta.isInternal) should_reset_visitor = true;
                if (meta.cache && meta.cache.get(meta.key)?.poToken === poToken) {
                    meta.cache.delete(meta.key);
                }
            }
        }

        if (target_key) {
            for (const prefix of ['v:', 'lr:', 'int:', 'ext:']) {
                inf.delete(prefix + target_key);
            }
            for (const [entry_cache, entry_internal] of [
                [cache, false],
                [lr_cache, false],
                [internal_visitor_cache, true]
            ]) {
                const cached = entry_cache.get(target_key);
                if (cached && (!poToken || cached.poToken === poToken)) {
                    if (!bad_session && cached.minterSession) {
                        bad_session = cached.minterSession;
                    }
                    if (entry_internal) should_reset_visitor = true;
                    entry_cache.delete(target_key);
                }
            }
        }

        if (should_reset_visitor) {
            resetVisitorData();
        }

        if (bad_session) {
            if (current_minter_session === bad_session) {
                current_minter_session = null;
            }
            pool.invalidate(bad_session);
        }

        return send(res, 200, {
            success: true,
            targeted: true,
            invalidatedSession: Boolean(bad_session),
            message: 'target token invalidated'
        });
    }

    if (path === '/minter_cache' && req.method === 'GET') {
        return send(res, 200, {
            current_minter_session: current_minter_session || null,
            workers: pool.stats().workers
        });
    }

    if (path === '/ready' && req.method === 'GET')
        return send(res, pool.stats().workers > 0 ? 200 : 503, {
            status: pool.stats().workers > 0 ? 'ready' : 'unavailable',
            ...pool.stats()
        });

    if (path === '/metrics' && req.method === 'GET') {
        setStats({ ...metrics, ...pool.stats() });

        res.writeHead(200, {
            'Content-Type': metricsContentType,
            'Cache-Control': 'no-store'
        });
        res.end(await text());
        return;
    }

    if (path === '/metrics/json' && req.method === 'GET')
        return send(res, 200, {
            ...metrics,
            cacheSize: cache.size + lr_cache.size + internal_visitor_cache.size,
            inFlight: inf.size,
            ...pool.stats()
        });

    if (path === '/decode_cold_start' && req.method === 'POST') {
        try {
            const body = await readBody(req);
            const err = validateColdStartDecode(body);

            if (err) return send(res, 400, { error: err });

            return send(res, 200, decodeColdStartToken(body.token));
        } catch (error) {
            return send(res, 400, { error: error.message || 'invalid coldStarToken' });
        }
    }

    if (path !== '/generate' || req.method !== 'POST') return send(res, 404, { error: 'not found' });

    if (metrics.pendingRequests >= maxPendingRequests) return send(res, 503, { error: 'service overloaded' });

    metrics.pendingRequests++;
    pendingRequests.set(metrics.pendingRequests);

    try {
        let body;
        try {
            body = await readBody(req);
        } catch (error) {
            return send(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: error.message });
        }

        const err = validateGeneration(body);

        if (err) return send(res, 400, { error: err });

        try {
            const explicit_binding = typeof body.content_binding === 'string' && body.content_binding.trim().length > 0;
            const contentBinding = explicit_binding
                ? body.content_binding.trim()
                : await getVisitorData(visitorTtl, 30000);
            const req_ttl = Number.isFinite(body.ttl) && body.ttl > 0 ? body.ttl * 1000 : null;

            return send(
                res,
                200,
                responseWithColdStartToken(
                    await generate(contentBinding, explicit_binding, req_ttl),
                    body.coldToken === true
                )
            );
        } catch (error) {
            metrics.failures++;
            record('error');
            console.error(`WebPO generation failed: ${error.message}`);

            const status = error.code === 'QUEUE_FULL' ? 503 : error.code === 'TIMEOUT' ? 504 : 500;

            return send(res, status, {
                error:
                    status === 503
                        ? 'service overloaded'
                        : status === 504
                            ? 'generation timed out'
                            : 'generation failed'
            });
        }
    } finally {
        metrics.pendingRequests--;

        pendingRequests.set(metrics.pendingRequests);

        const stats = pool.stats();
        queueDepth.set(stats.queue ?? 0);
        activeWorkers.set(stats.workers ?? 0);
    }
}

const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const route = pathname(req.url);

    res.once('finish', () =>
        observe(req.method, route, res.statusCode, Number(process.hrtime.bigint() - started) / 1e6)
    );

    handle(req, res).catch(() => send(res, 500, { error: 'internal server error' }));
});

server.requestTimeout = server.headersTimeout = 15000;

let is_shutdow_started = false;

async function prewarm() {
    if (process.env.PREWARM === 'false' || is_shutdow_started) {
        return;
    }
    try {
        const session = await getVisitorSession(visitorTtl, 15000);
        if (is_shutdow_started || !session?.visitorData) {
            return;
        }
        if (session.gl) {
            const target_tz = resolveTimezoneForCountry(session.gl);
            if (target_tz) {
                pool.setTimezone(target_tz);
            }
        }
        if (!is_shutdow_started) {
            await generate(session.visitorData, false, null);
        }
    } catch (error) {
        if (!is_shutdow_started) {
            console.warn(`prewarmup skipped: ${error.message}`);
        }
    }
}

function listen(host) {
    server.once('error', (error) => {
        if (host == '::') {
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
        void prewarm();
    });
}

listen(host);

async function shutdown(signal) {
    is_shutdow_started = true;
    console.log(`${signal}: shutting down`);
    cache.close();
    lr_cache.close();
    internal_visitor_cache.close();
    server.close();
    await pool.close();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('SIGTERM', () => shutdown('SIGTERM'));
