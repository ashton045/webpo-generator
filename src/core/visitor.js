import {
    USER_AGENT,
    VISITOR_ID_ENDPOINT,
    WEB_CLIENT_ID,
    WEB_CLIENT_NAME,
    WEB_CLIENT_VERSION,
    YT_BASE
} from '../utils/constants.js';

let visitorData;
let visitorGl = null;
let visitor_expires = 0;
let reqs;
let generation = 0;

export function parseSwJsData(data) {
    if (typeof data !== 'string' || !data.trim()) return null;
    const cleaned = data.replace(/^\)\]\}'\s*/, '');
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return null;
    }

    const row = parsed?.[0]?.[2]?.[0]?.[0];
    if (!Array.isArray(row)) return null;

    const gl = typeof row[1] === 'string' && /^[A-Za-z]{2}$/.test(row[1]) ? row[1].toUpperCase() : null;
    let found = null;
    for (const cell of row) {
        if (typeof cell === 'string' && /^Cg[A-Za-z0-9_%=-]{12,}$/.test(cell)) {
            try {
                found = decodeURIComponent(cell);
            } catch {
                found = cell;
            }
            break;
        }
    }

    if (!found && !gl) return null;
    return { visitorData: found, gl };
}

export async function fetchSwJsSession(timeout = 15000) {
    const res = await fetch(`${YT_BASE}/sw.js_data`, {
        headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': USER_AGENT
        },
        signal: AbortSignal.timeout(timeout)
    });

    if (!res.ok) throw new Error(`sw.js_data returned ${res.status}`);

    const parsed = parseSwJsData(await res.text());
    if (!parsed?.visitorData) {
        throw new Error('visitor data was not found in sw.js_data');
    }
    return parsed;
}

function extract(value) {
    if (!value || typeof value !== 'object') return;

    if (typeof value.VISITOR_DATA === 'string') return value.VISITOR_DATA;

    if (typeof value.visitorData === 'string') return value.visitorData;

    if (typeof value.visitor_id === 'string') return value.visitor_id;

    for (const child of Object.values(value)) {
        const result = extract(child);
        if (result) return result;
    }
}

async function fetch_initial_page(timeout) {
    const res = await fetch(YT_BASE, {
        headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': USER_AGENT
        },
        signal: AbortSignal.timeout(timeout)
    });

    if (!res.ok) throw new Error(`something went wrong ${res.status}`);

    const txt = await res.text();
    const config = txt.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
    const visitor =
        txt.match(/VISITOR_DATA\s*[:=]\s*["']([^"']+)["']/i)?.[1] ||
        txt.match(/visitorData\s*[:=]\s*["']([^"']+)["']/i)?.[1];
    const result = visitor || (config ? extract(JSON.parse(config)) : undefined);

    if (!result) throw new Error('visitor data was not found in yt initial page');

    return decodeURIComponent(result);
}

async function visitor_endpoint(timeout) {
    const res = await fetch(VISITOR_ID_ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
            'x-youtube-client-name': WEB_CLIENT_ID,
            'x-youtube-client-version': WEB_CLIENT_VERSION
        },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
            context: {
                client: {
                    clientName: WEB_CLIENT_NAME,
                    clientVersion: WEB_CLIENT_VERSION
                }
            }
        })
    });

    if (!res.ok) throw new Error(`something went wrong ${res.status}`);

    const result = extract(await res.json());

    if (!result) throw new Error('visitor data not fond');

    return decodeURIComponent(result);
}

export async function getVisitorSession(ttl = 10 * 60 * 1000, timeout = 30000) {
    if (visitorData && visitor_expires > Date.now()) {
        return { visitorData, gl: visitorGl };
    }

    if (reqs) return reqs;

    const epoch = generation;
    const cur_req = (async () => {
        try {
            return await fetchSwJsSession(timeout);
        } catch (swErr) {
            try {
                return { visitorData: await fetch_initial_page(timeout), gl: null };
            } catch (e) {
                try {
                    return { visitorData: await visitor_endpoint(timeout), gl: null };
                } catch (e2) {
                    throw new Error(`could not generate visitor data: ${swErr.message}; ${e.message}; ${e2.message}`);
                }
            }
        }
    })()
        .then((session) => {
            if (epoch === generation) {
                visitorData = session.visitorData;
                visitorGl = session.gl || null;
                visitor_expires = Date.now() + ttl;
            }
            return session;
        })
        .finally(() => {
            if (reqs === cur_req) {
                reqs = undefined;
            }
        });

    reqs = cur_req;
    return cur_req;
}

export function getVisitorData(ttl = 10 * 60 * 1000, timeout = 30000) {
    return getVisitorSession(ttl, timeout).then((session) => session.visitorData);
}

export function resetVisitorData() {
    generation++;
    visitorData = undefined;
    visitorGl = null;
    visitor_expires = 0;
    reqs = undefined;
}
