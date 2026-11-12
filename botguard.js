import { JSDOM } from 'jsdom';
import { COLD_START_MAX_BINDING_BYTES, INNERTUBE_API_KEY, REQUEST_KEY, TV_CONFIG, TV_USER_AGENT, USER_AGENT, YT_BASE, WEB_CLIENT_NAME, WEB_CLIENT_VERSION } from './src/utils/constants.js';
import { base64ToUint8, buildURL, parse_json, Uint8ToBase64 } from './src/utils/helpers.js';

function release_dom(dom) {
    if (!dom) return;
    if (globalThis.window === dom.window) for (const p of ['window', 'document', 'location', 'origin', 'yt', 'navigator']) { try { delete globalThis[p]; } catch { globalThis[p] = undefined; } }
    dom.window.close();
}

function parse_waa_challenge(raw) {
    if (raw?.bgChallenge) return raw;
    if (raw?.[0]?.bgChallenge) return raw[0];
    let data;
    if (raw?.length > 1 && typeof raw[1] === 'string') data = JSON.parse(new TextDecoder().decode(base64ToUint8(raw[1]).map(v => v + 97)));
    else if (Array.isArray(raw?.[0])) data = raw[0];
    else if (Array.isArray(raw)) data = raw;
    if (!Array.isArray(data)) return;
    const [messageId, wrappedScript, wrappedUrl, interpreterHash, program, globalName] = data;
    const script = Array.isArray(wrappedScript) ? wrappedScript.find(v => typeof v === 'string') : undefined;
    const url = Array.isArray(wrappedUrl) ? wrappedUrl.find(v => typeof v === 'string') : undefined;
    if (!program || !globalName || (!url && !script)) return;
    return { bgChallenge: { messageId, program, globalName, interpreterHash,
        interpreterUrl: url ? { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: url } : undefined,
        interpreterJavascript: { privateDoNotAccessOrElseSafeScriptWrappedValue: script } } };
}

export async function create_bg(o) {
    const vm = o.globalObject[o.globalName];
    if (!vm || !vm.a) throw new Error('BotGuard VM unavailable');
    const fns = Promise.withResolvers();
    const cb = (async_snapshot, shutdown, pass_event, check_camera) => fns.resolve({ async_snapshot, shutdown, pass_event, check_camera });
    const sync_snapshot = await vm.a(o.program, cb, true, o.userInteractionElement, () => {}, [[], []], undefined, false, [])?.[0];
    const arr = a => [a.contentBinding, a.signedTimestamp, a.webPoSignalOutput, a.skipPrivacyBuffer];
    return {
        async snapshot(args, timeout = 3000) {
            const { async_snapshot } = await fns.promise;
            return await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('VM operation timed out')), timeout);
                async_snapshot(r => { clearTimeout(t); resolve(r); }, arr(args));
            });
        },
        async pass_event(a) { return (await fns.promise).pass_event?.(a); },
        async check_camera(a) { return (await fns.promise).check_camera?.(a); },
        async shutdown() { return (await fns.promise).shutdown?.(); },
        async snapshot_synchronous(a) {
            if (!sync_snapshot) throw new Error('synchronous snapshot function not found');
            return sync_snapshot(arr(a));
        }
    };
}

export class Minter {
    constructor(callback, client, dom, iTdata) {
        this.callback = callback; this.client = client; this.dom = dom;
        this.integrityTokenData = iTdata;
        this.expiresAt = iTdata?.expiresAt || 0;
        const th = Number(iTdata?.mint_refresh_threshold ?? iTdata?.mintRefreshThreshold);
        this.mintThreshold = Number.isFinite(th) && th > 0 ? th : 100;
        this.mintCount = 0; this.active = 0; this.retired = false; this.closed = false;
    }
    isExhausted() { return this.mintThreshold > 0 && this.mintCount >= this.mintThreshold; }
    static async create(integrityToken, signals, client, dom) {
        const getMinter = signals[0];
        if (!getMinter || !integrityToken?.integrity_token) throw new Error('Could not create WebPO minter');
        const callback = await getMinter(base64ToUint8(integrityToken?.integrity_token));
        if (!(callback instanceof Function)) throw new Error('WebPO minter unavailable');
        return new Minter(callback, client, dom, integrityToken);
    }
    retire() { this.retired = true; this.close_idles(); }
    close_idles() {
        if (!this.retired || this.active > 0 || this.closed) return;
        this.closed = true;
        release_dom(this.dom);
        Promise.resolve(this.client?.shutdown?.()).catch(() => {});
    }
    async mintAsWebsafeString(binding) {
        this.active++; this.mintCount++;
        try { return Uint8ToBase64(await this.callback(new TextEncoder().encode(binding)), true); }
        finally { this.active--; this.close_idles(); }
    }
}

let minter_promise, expires = 0, cur;

export async function getWebPo(useYouTubeAPI = true) {
    if (cur && cur.isExhausted()) { cur.retire(); cur = undefined; minter_promise = undefined; expires = 0; }
    if (minter_promise && (expires === 0 || expires > Date.now() + 15000)) return minter_promise;

    cur?.retire();
    cur = undefined;
    minter_promise = undefined;
    let runtime_dom;

    minter_promise = (async () => {
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: YT_BASE, referrer: `${YT_BASE}/`, userAgent: USER_AGENT });
        runtime_dom = dom;
        Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, origin: dom.window.origin });
        Object.defineProperty(dom.window.navigator, 'userAgent', { value: USER_AGENT, configurable: true });
        Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
        console.log('[WebPO] WEB UA matched:', navigator.userAgent === USER_AGENT);

        let key = REQUEST_KEY, challenge, eacrToken;

        // 1) Homepage: ytcfg + ytAtN challenge
        try {
            const res = await fetch(YT_BASE, { headers: { accept: '*/*', 'accept-language': 'en-US,en;q=0.7', 'user-agent': USER_AGENT } });
            const txt = await res.text();
            dom.window.yt = dom.window.yt || { config_: {} };
            dom.window.yt.config_ = dom.window.yt.config_ || {};
            const cfg = dom.window.yt.config_;

            for (const m of txt.matchAll(/ytcfg\.set\(({.+?})\);/gs)) {
                try { Object.assign(cfg, JSON.parse(m[1])); } catch { try { Object.assign(cfg, parse_json(m[1])); } catch {} }
            }
            for (const m of txt.matchAll(/ytcfg\.set\(["']([A-Za-z0-9_]+)["']\s*,\s*(["'].*?["']|true|false|\d+|{[^}]+}|\[[^\]]+\])\);/gs)) {
                try { cfg[m[1]] = JSON.parse(m[2]); } catch { cfg[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
            }
            if (!cfg.EVENT_ID) { const e = txt.match(/"EVENT_ID"\s*:\s*"([^"]+)"/); if (e) cfg.EVENT_ID = e[1]; }
            globalThis.yt = dom.window.yt;

            const att = txt.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
            if (att) {
                try { const p = parse_json(att[1]); challenge = p.R?.bgChallenge ? p.R : parse_waa_challenge(p.R); eacrToken = p.T; }
                catch { challenge = undefined; }
            }
            if (!challenge?.bgChallenge && !eacrToken) {
                const ia = txt.match(/initialAttestationDataJson\s*=\s*({[\s\S]*?});/);
                if (ia) { try { const p = parse_json(ia[1]); challenge = p.R?.bgChallenge ? p.R : parse_waa_challenge(p.R); eacrToken = p.T || eacrToken; } catch {} }
            }
        } catch {}

        // 2) att/get
        if (!challenge?.bgChallenge) {
            try {
                const payload = { context: { client: { clientName: WEB_CLIENT_NAME, clientVersion: WEB_CLIENT_VERSION } }, engagementType: 'ENGAGEMENT_TYPE_UNBOUND' };
                if (eacrToken) payload.eacrToken = eacrToken;
                const r = await fetch(`${YT_BASE}/youtubei/v1/att/get?prettyPrint=false`, { method: 'POST', body: JSON.stringify(payload),
                    headers: { accept: '*/*', 'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-goog-api-key': INNERTUBE_API_KEY } });
                if (!r.ok) throw new Error(`att/get returned ${r.status}`);
                const a = await r.json();
                if (!a?.bgChallenge) throw new Error('could not get challenge from att/get');
                challenge = { bgChallenge: a.bgChallenge };
            } catch { challenge = undefined; }
        }

        // 3) WAA Create
        if (!challenge?.bgChallenge) {
            const r = await fetch(buildURL('Create', false), { method: 'POST', body: JSON.stringify([key]),
                headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': INNERTUBE_API_KEY, 'x-user-agent': 'grpc-web-javascript/0.1', 'user-agent': USER_AGENT } });
            if (!r.ok) throw new Error(`WAA Create returned ${r.status}`);
            challenge = parse_waa_challenge(await r.json());
        }

        // 4) TV config
        if (!challenge?.bgChallenge) {
            try {
                const txt = await (await fetch(TV_CONFIG, { headers: { accept: '*/*', 'user-agent': TV_USER_AGENT } })).text();
                if (!txt.startsWith(')]}')) throw new Error('invalid yt tv config response');
                const json = JSON.parse(txt.slice(4));
                challenge = json.challengeParams?.R ? JSON.parse(json.challengeParams.R) : undefined;
                key = json.challengeRequestKey || key;
            } catch { challenge = undefined; }
        }

        if (!challenge?.bgChallenge) throw new Error('Could not get botguard challenge');

        const bg = challenge.bgChallenge;
        const iUrl = bg.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
        const inline = bg.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
        const interpreter = inline || (iUrl ? await (await fetch(`https:${iUrl}`)).text() : '');
        if (!interpreter) throw new Error("couldn't load botguard interpreter");

        new Function(interpreter)();

        const client = await create_bg({ program: bg.program, globalName: bg.globalName, globalObject: globalThis });
        const signals = [];
        const snapshot = await client.snapshot({ webPoSignalOutput: signals });
        const endpoint = buildURL('GenerateIT', useYouTubeAPI);
        const opts = k => ({ method: 'POST', body: JSON.stringify([key, snapshot]),
            headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': k, 'x-user-agent': 'grpc-web-javascript/0.1', 'user-agent': USER_AGENT } });

        const r = await fetch(endpoint, opts(INNERTUBE_API_KEY));
        if (!r.ok) throw new Error(`GenerateIT returned ${r.status}`);
        const [integrity_token, estimated_ttl_secs, mint_refresh_threshold, websafe_fallback_token] = await r.json();

        const ttl = Number(estimated_ttl_secs);
        expires = Date.now() + Math.max(1, (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) - 30) * 1000;

        const minter = await Minter.create({ integrity_token, mint_refresh_threshold, websafe_fallback_token, expiresAt: expires }, signals, client, dom);
        minter.expiresAt = expires;
        cur = minter;
        return minter;
    })();

    try { return await minter_promise; }
    catch (e) { release_dom(runtime_dom); minter_promise = undefined; expires = 0; throw e; }
}

export async function fetch_pot(contentBinding, useYouTubeAPI = true, ttl = null) {
    const minter = await getWebPo(useYouTubeAPI);
    const minter_expires = minter.expiresAt || expires;
    const token_expires = Number.isFinite(ttl) && ttl > 0 ? Math.min(minter_expires, Date.now() + ttl) : minter_expires;
    return {
        poToken: await minter.mintAsWebsafeString(contentBinding),
        contentBinding,
        ttl: Math.max(0, Math.floor((token_expires - Date.now()) / 1000)),
        minterSession: minter.integrityTokenData?.integrity_token || null
    };
}

// Bridges the short period before yt moves sps from 2 to 3. Generated per response (contains current time).
export function createColdStartToken(contentBinding, clientState = 1) {
    const bytecode = new TextEncoder().encode(contentBinding);
    if (bytecode.length > COLD_START_MAX_BINDING_BYTES) return;
    const ts = Math.floor(Date.now() / 1000);
    const header = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), 0, clientState, (ts >> 24) & 0xff, (ts >> 16) & 0xff, (ts >> 8) & 0xff, ts & 0xff];
    const packet = new Uint8Array(2 + header.length + bytecode.length);
    packet[0] = 34;
    packet[1] = header.length + bytecode.length;
    packet.set(header, 2);
    packet.set(bytecode, 2 + header.length);
    const payload = packet.subarray(2);
    for (let i = 2; i < payload.length; i++) payload[i] ^= payload[i % 2];
    return Uint8ToBase64(packet, true);
}

export function decodeColdStartToken(token) {
    const packet = base64ToUint8(token);
    if (packet.length < 10 || packet[0] !== 34) throw new Error('invalid cold start token');
    const length = packet[1];
    if (packet.length !== length + 2 || length < 8) throw new Error('invalid cold start packet length');
    const p = packet.slice(2);
    for (let i = 2; i < p.length; i++) p[i] ^= p[i % 2];
    const timestamp = ((p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7]) >>> 0;
    return { contentBinding: new TextDecoder().decode(p.subarray(8)), timestamp, unknownVal: p[2], clientState: p[3], keys: [p[0], p[1]], date: new Date(timestamp * 1000) };
}