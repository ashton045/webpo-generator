import client from 'prom-client';

const { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } = client;

const routes = new Set(['/', '/generate', '/health', '/ready', '/metrics', '/metrics/json']);

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'webpo_' });

const reqs = new Counter({
    name: 'webpo_http_requests_total',
    help: 'totl http requests received by route and method.',
    labelNames: ['method', 'route'],
    registers: [registry]
});

const res = new Counter({
    name: 'webpo_http_responses_total',
    help: 'totl HTTP responses by route, method, and status code.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry]
});

const dur = new Histogram({
    name: 'webpo_http_request_duration_seconds',
    help: 'totl request duration in seconds.',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry]
});

const generations = new Counter({
    name: 'webpo_generation_total',
    help: 'webpo generation attempts by outcome.',
    labelNames: ['outcome'],
    registers: [registry]
});

const cache_events = new Counter({
    name: 'webpo_cache_events_total',
    help: 'webpo cache hits and misses.',
    labelNames: ['result'],
    registers: [registry]
});

export const pendingRequests = new Gauge({
    name: 'webpo_pending_requests',
    help: 'current number of HTTP generation requests in progress.',
    registers: [registry]
});

export const queueDepth = new Gauge({
    name: 'webpo_queue_depth',
    help: 'current worker queue depth.',
    registers: [registry]
});

export const activeWorkers = new Gauge({
    name: 'webpo_active_workers',
    help: 'current number of configured workers.',
    registers: [registry]
});

export function observe(method, route, status, durationMs) {
    const safeRoute = isRoute(route);

    reqs.inc({ method, route: safeRoute });
    res.inc({ method, route: safeRoute, status: String(status) });
    dur.observe({ method, route: safeRoute }, durationMs / 1000);
}

export function record(outcome) {
    generations.inc({ outcome });
}

export function record_cache(result) {
    cache_events.inc({ result });
}

export function setStats(stats) {
    pendingRequests.set(stats.pendingRequests ?? 0);
    queueDepth.set(stats.queue ?? stats.queued ?? 0);
    activeWorkers.set(stats.workers ?? 0);
}

export function text() {
    return registry.metrics();
}

export const metricsContentType = registry.contentType;

function isRoute(route) {
    return routes.has(route) ? route : '/other';
}
