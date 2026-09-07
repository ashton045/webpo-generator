import { USER_AGENT, VISITOR_ID_ENDPOINT, WEB_CLIENT_ID, WEB_CLIENT_NAME, WEB_CLIENT_VERSION, YT_BASE } from '../utils/constants.js';

let visitorData;
let visitor_expires = 0;
let reqs;

function extract(value) {

    if(!value || typeof value !== 'object')
        return;

    if(typeof value.VISITOR_DATA === 'string')
        return value.VISITOR_DATA;

    if(typeof value.visitorData === 'string')
        return value.visitorData;

    if(typeof value.visitor_id === 'string')
        return value.visitor_id;

    for(const child of Object.values(value)) {
        const result = extract(child);
        if (result) return result;
    }
}

async function fetch_initial_page(timeout) {

    const res = await fetch(YT_BASE, {
        'headers': {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': USER_AGENT
        },
        'signal': AbortSignal.timeout(timeout)
    });

    if(!res.ok)
        throw new Error(`something went wrong ${res.status}`);

    const txt = await res.text();
    const config = txt.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
    const visitor = txt.match(/VISITOR_DATA\s*[:=]\s*["']([^"']+)["']/i)?.[1] || txt.match(/visitorData\s*[:=]\s*["']([^"']+)["']/i)?.[1];
    const result = visitor || (config ? extract(JSON.parse(config)) : undefined);

    if(!result)
        throw new Error('visitor data was not found in yt initial page');

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

    if(!res.ok)
        throw new Error(`something went wrong ${res.status}`);

    const result = extract(await res.json());

    if(!result)
        throw new Error('visitor data not fond');

    return decodeURIComponent(result);
}

export function getVisitorData(ttl = 10 * 60 * 1000, timeout = 30000) {

    if(visitorData && visitor_expires > Date.now())
        return Promise.resolve(visitorData);

    if(reqs) return reqs;

    reqs = (async () => {

        try {
            return (await fetch_initial_page(timeout));
        }
        catch(e) {
            try {
                return (await visitor_endpoint(timeout));
            }
            catch (e2) {
                throw new Error(`could not generate visitor data: ${e.message}; ${e2.message}`);
            }
        }
    })().then((v) => {
        visitorData = v;
        visitor_expires = Date.now() + ttl;
        return v;
    }).finally(() => {
        reqs = undefined;
    });

    return reqs;
}
