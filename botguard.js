import https from 'node:https';
import { parentPort } from 'node:worker_threads';
import ct from 'countries-and-timezones';
import { JSDOM } from 'jsdom';
import {
    COLD_START_MAX_BINDING_BYTES,
    INNERTUBE_API_KEY,
    REQUEST_KEY,
    TV_CONFIG,
    TV_USER_AGENT,
    USER_AGENT,
    YT_BASE,
    WEB_CLIENT_NAME,
    WEB_CLIENT_VERSION
} from './src/utils/constants.js';
import { base64ToUint8, buildURL, parse_json, Uint8ToBase64 } from './src/utils/helpers.js';

function fetchTextHttps(urlStr, headers = {}, maxHeaderSize = 65536, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.request(urlStr, { method: 'GET', headers, maxHeaderSize, timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('timeout', () => req.destroy(new Error(`HTTPS request timed out: ${urlStr}`)));
        req.on('error', reject);
        req.end();
    });
}

const DEFAULT_NAVIGATOR = globalThis.navigator;

export function release_dom(dom, globalName, vmRef) {
    if (globalName && (vmRef === undefined || globalThis[globalName] === vmRef)) {
        try {
            delete globalThis[globalName];
        } catch {
            globalThis[globalName] = undefined;
        }
    }

    if (!dom) return;

    if (globalThis.window === dom.window) {
        for (const property of ['window', 'document', 'location', 'origin', 'yt']) {
            try {
                delete globalThis[property];
            } catch {
                globalThis[property] = undefined;
            }
        }
        if (DEFAULT_NAVIGATOR !== undefined) {
            Object.defineProperty(globalThis, 'navigator', {
                value: DEFAULT_NAVIGATOR,
                configurable: true,
                writable: true
            });
        }
    }

    try {
        dom.window.close();
    } catch {}
}

function disposeRuntime(dom, client, globalName, vmRef) {
    if (client?.shutdown) {
        return Promise.resolve(client.shutdown())
            .catch(() => {})
            .finally(() => release_dom(dom, globalName, vmRef));
    }
    release_dom(dom, globalName, vmRef);
    return Promise.resolve();
}

function parse_waa_challenge(raw_data) {
    if (raw_data?.bgChallenge) return raw_data;

    if (raw_data?.[0]?.bgChallenge) return raw_data[0];

    let challenge_data;

    if (raw_data?.length > 1 && typeof raw_data[1] === 'string') {
        const bytes = base64ToUint8(raw_data[1]);
        challenge_data = JSON.parse(new TextDecoder().decode(bytes.map((value) => value + 97)));
    } else if (Array.isArray(raw_data?.[0])) {
        challenge_data = raw_data[0];
    } else if (Array.isArray(raw_data)) {
        challenge_data = raw_data;
    }

    if (!Array.isArray(challenge_data)) return;

    const [message_id, wrapped_script, wrapped_url, interpreter_hash, program, global_name] = challenge_data;
    const script = Array.isArray(wrapped_script)
        ? wrapped_script.find((value) => typeof value === 'string')
        : undefined;
    const interpreter_url = Array.isArray(wrapped_url)
        ? wrapped_url.find((value) => typeof value === 'string')
        : undefined;

    if (!program || !global_name || (!interpreter_url && !script)) return;

    return {
        bgChallenge: {
            messageId: message_id,
            program,
            globalName: global_name,
            interpreterHash: interpreter_hash,
            interpreterUrl: interpreter_url
                ? {
                      privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: interpreter_url
                  }
                : undefined,
            interpreterJavascript: {
                privateDoNotAccessOrElseSafeScriptWrappedValue: script
            }
        }
    };
}

export async function create_bg(options) {
    const vm = options.globalObject[options.globalName];

    if (!vm || !vm.a) throw new Error('BotGuard VM unavailable');

    const vm_functions = Promise.withResolvers();

    const callback = (async_snapshot, shutdown, pass_event, check_camera) => {
        vm_functions.resolve({ async_snapshot, shutdown, pass_event, check_camera });
    };

    const sync_snapshot = await vm.a(
        options.program,
        callback,
        true,
        options.userInteractionElement,
        () => {},
        [[], []],
        undefined,
        false,
        []
    )?.[0];

    return {
        async snapshot(args, timeout = 3000) {
            const { async_snapshot } = await vm_functions.promise;

            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('VM operation timed out')), timeout);

                async_snapshot(
                    (res) => {
                        clearTimeout(timer);
                        resolve(res);
                    },
                    [args.contentBinding, args.signedTimestamp, args.webPoSignalOutput, args.skipPrivacyBuffer]
                );
            });
        },
        async pass_event(args) {
            const { pass_event } = await vm_functions.promise;
            return pass_event?.(args);
        },
        async check_camera(args) {
            const { check_camera } = await vm_functions.promise;
            return check_camera?.(args);
        },
        async shutdown() {
            const { shutdown } = await vm_functions.promise;
            return shutdown?.();
        },
        async snapshot_synchronous(args) {
            if (!sync_snapshot) throw new Error('synchronous snapshot function not found');
            return sync_snapshot([
                args.contentBinding,
                args.signedTimestamp,
                args.webPoSignalOutput,
                args.skipPrivacyBuffer
            ]);
        }
    };
}

export class Minter {
    constructor(callback, client, dom, iTdata, globalName, vmRef) {
        this.callback = callback;
        this.client = client;
        this.dom = dom;
        this.integrityTokenData = iTdata;
        this.globalName = globalName;
        this.vmRef = vmRef;
        this.expiresAt = iTdata?.expiresAt || 0;
        const threshold = Number(iTdata?.mint_refresh_threshold ?? iTdata?.mintRefreshThreshold);
        this.mintThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 100;
        this.mintCount = 0;
        this.active = 0;
        this.retired = false;
        this.closed = false;
    }

    isExhausted() {
        return this.mintThreshold > 0 && this.mintCount >= this.mintThreshold;
    }

    static async create(integrityToken, webPoSignalOutput, client, dom, globalName, vmRef) {
        const getMinter = webPoSignalOutput[0];

        if (!getMinter || !integrityToken?.integrity_token) throw new Error('Could not create WebPO minter');

        const callback = await getMinter(base64ToUint8(integrityToken?.integrity_token));

        if (!(callback instanceof Function)) throw new Error('WebPO minter unavailable');

        return new Minter(callback, client, dom, integrityToken, globalName, vmRef);
    }

    retire() {
        this.retired = true;
        this.close_idles();
    }

    close_idles() {
        if (!this.retired || this.active > 0 || this.closed) return;

        this.closed = true;
        disposeRuntime(this.dom, this.client, this.globalName, this.vmRef);
    }

    async mintAsWebsafeString(contentBinding) {
        this.active++;
        this.mintCount++;

        try {
            const raw = await this.callback(new TextEncoder().encode(contentBinding));
            if (!raw || raw.length === 0) {
                throw new Error('Minter returned empty token bytes');
            }
            const poToken = Uint8ToBase64(raw, true);
            if (!poToken || poToken.length < 20) {
                throw new Error('Generated poToken is unexpectedly short');
            }
            return poToken;
        } finally {
            this.active--;
            this.close_idles();
        }
    }
}

let minter_promise;
let expires = 0;
let cur;
let cur_source;
let promise_allows_fallback = false;
let minter_generation = 0;

export function isVideoIdBinding(binding) {
    if (typeof binding !== 'string') return false;
    let key = binding.trim();
    if (!key) return false;
    try {
        key = decodeURIComponent(key);
    } catch {}
    return /^[A-Za-z0-9_-]{11}$/.test(key);
}

export function isLivingRoomIdBinding(binding) {
    if (typeof binding !== 'string') return false;
    let key = binding.trim();
    if (!key) return false;
    try {
        key = decodeURIComponent(key);
    } catch {}
    return /^[A-Za-z0-9+/_-]{11}=$/.test(key);
}

function canSourceServeRequest(source, allow_fallback) {
    if (source === 'homepage' || source === 'att_eacr') return true;
    if (allow_fallback) return true;
    if (source === 'att_unbound') return process.env.ALLOW_UNBOUND_ATT_FALLBACK === 'true';
    if (source === 'waa_create') return process.env.ALLOW_WAA_CREATE_FALLBACK === 'true';
    if (source === 'tv_config') return process.env.ALLOW_TV_CONFIG_FALLBACK === 'true';
    return false;
}

export function resetMinter(sessionToken = null) {
    if (sessionToken && cur?.integrityTokenData?.integrity_token !== sessionToken) {
        return false;
    }
    minter_generation++;
    cur?.retire();
    cur = undefined;
    cur_source = undefined;
    minter_promise = undefined;
    promise_allows_fallback = false;
    expires = 0;
    return true;
}

function resolveTimezoneForCountry(gl) {
    if (typeof gl !== 'string' || !gl.trim()) return null;
    const code = gl.trim().toUpperCase();
    const country = ct.getCountry?.(code) || ct.default?.getCountry?.(code);
    if (country?.timezones?.length) {
        return country.timezones[0];
    }
    try {
        const locale = new Intl.Locale(`und-${code}`);
        const zones = locale.getTimeZones?.() || locale.timeZones;
        if (Array.isArray(zones) && zones.length > 0) {
            return zones[0];
        }
    } catch {}
    return null;
}

async function syncTimezoneWithGeo(gl) {
    const targetTz = resolveTimezoneForCountry(gl);
    if (!targetTz || targetTz === 'UTC' || targetTz === 'Etc/UTC') return;
    try {
        Intl.DateTimeFormat(undefined, { timeZone: targetTz });
        const currentTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!currentTz || currentTz === 'UTC' || currentTz === 'Etc/UTC') {
            if (parentPort) {
                parentPort.postMessage({ type: 'sync_tz', tz: targetTz });
                await new Promise((resolve) => setTimeout(resolve, 100));
            } else {
                process.env.TZ = targetTz;
                new Date().getTimezoneOffset();
            }
        }
    } catch {}
}

async function applyYtConfigFromHtml(dom, txt) {
    dom.window.yt = { config_: {} };

    for (const match of txt.matchAll(/ytcfg\.set\(({.+?})\);/gs)) {
        try {
            Object.assign(dom.window.yt.config_, JSON.parse(match[1]));
        } catch {
            try {
                Object.assign(dom.window.yt.config_, parse_json(match[1]));
            } catch {}
        }
    }

    const reg_match = txt.matchAll(
        /ytcfg\.set\(["']([A-Za-z0-9_]+)["']\s*,\s*(["'].*?["']|true|false|\d+|{[^}]+}|\[[^\]]+\])\);/gs
    );

    for (const match of reg_match) {
        try {
            dom.window.yt.config_[match[1]] = JSON.parse(match[2]);
        } catch {
            dom.window.yt.config_[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
    }

    if (!dom.window.yt.config_.EVENT_ID) {
        const event_reg = txt.match(/"EVENT_ID"\s*:\s*"([^"]+)"/);
        if (event_reg) {
            dom.window.yt.config_.EVENT_ID = event_reg[1];
        }
    }

    const gl =
        dom.window.yt.config_.INNERTUBE_CONTEXT_GL ||
        dom.window.yt.config_.GL ||
        dom.window.yt.config_.INNERTUBE_CONTEXT?.client?.gl;
    await syncTimezoneWithGeo(gl);

    globalThis.yt = dom.window.yt;
}

function parseAttestationPayload(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = parse_json(raw);
        }
    }
    if (!parsed) return {};
    return {
        challenge: parsed.R?.bgChallenge ? parsed.R : parse_waa_challenge(parsed.R),
        eacrToken: parsed.T
    };
}

function extractBalancedObject(txt, start_index) {
    if (start_index < 0 || txt[start_index] !== '{') return null;
    let depth = 0;
    let quote = null;
    for (let i = start_index; i < txt.length; i++) {
        const ch = txt[i];
        if (quote) {
            if (ch === '\\') {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return txt.slice(start_index, i + 1);
            }
        }
    }
    return null;
}

function extractHomepageAttestation(txt) {
    const yt_AtN_start = txt.match(/window\.ytAtN\(\s*(?=\{)/);
    if (yt_AtN_start) {
        const rawObj = extractBalancedObject(txt, yt_AtN_start.index + yt_AtN_start[0].length);
        if (rawObj) {
            try {
                const parsed = parseAttestationPayload(rawObj);
                if (parsed.challenge?.bgChallenge || parsed.eacrToken) return parsed;
            } catch {}
        }
    }

    const ytAtR = txt.match(/window\.ytAtR\s*=\s*(?:(['"])((?:\\.|(?!\1)[\s\S])*)\1|(?=\{))/);
    if (ytAtR) {
        try {
            const rawObj = ytAtR[2]
                ? ytAtR[2]
                      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                      .replace(/\\(['"\\])/g, '$1')
                : extractBalancedObject(txt, ytAtR.index + ytAtR[0].length);
            if (rawObj) {
                const parsed = parseAttestationPayload(rawObj);
                if (parsed.challenge?.bgChallenge || parsed.eacrToken) return parsed;
            }
        } catch {}
    }

    const initial_start = txt.match(/initialAttestationDataJson\s*=\s*(?=\{)/);
    if (initial_start) {
        const rawObj = extractBalancedObject(txt, initial_start.index + initial_start[0].length);
        if (rawObj) {
            try {
                const parsed = parseAttestationPayload(rawObj);
                if (parsed.challenge?.bgChallenge || parsed.eacrToken) return parsed;
            } catch {}
        }
    }

    return {};
}

async function fetchHomepageAttestation(dom) {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        try {
            const res = await fetch(YT_BASE, {
                headers: {
                    accept: '*/*',
                    'accept-language': 'en-US,en;q=0.7',
                    'user-agent': USER_AGENT,
                    cookie: 'SOCS=CAI'
                }
            });
            if (!res.ok) continue;

            const txt = await res.text();
            await applyYtConfigFromHtml(dom, txt);
            const extracted = extractHomepageAttestation(txt);
            if (extracted.challenge?.bgChallenge || extracted.eacrToken) {
                return extracted;
            }
        } catch {}
    }
    return {};
}

export async function getWebPo(useYouTubeAPI = true, options = {}) {
    const { allow_fallback = false } = options;

    while (minter_promise && (expires === 0 || expires > Date.now() + 15000)) {
        if (cur && cur.isExhausted()) {
            resetMinter();
            break;
        }

        if (cur && cur_source && !canSourceServeRequest(cur_source, allow_fallback)) {
            resetMinter();
            break;
        }

        const pending = minter_promise;
        const pending_allows_fallback = promise_allows_fallback;
        let candidate;
        try {
            candidate = await pending;
        } catch (error) {
            if (allow_fallback && !pending_allows_fallback) {
                if (!minter_promise) break;
                continue;
            }
            throw error;
        }

        if (minter_promise !== pending) {
            continue;
        }

        if (candidate?.isExhausted?.() || (cur_source && !canSourceServeRequest(cur_source, allow_fallback))) {
            resetMinter();
            break;
        }

        return candidate;
    }

    resetMinter();
    promise_allows_fallback = allow_fallback;
    const build_gen = minter_generation;

    let runtime_dom;
    let runtime_client;
    let runtime_global_name;
    let runtime_vm_ref;

    minter_promise = (async () => {
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
            url: YT_BASE,
            referrer: `${YT_BASE}/`,
            resources: { userAgent: USER_AGENT }
        });

        runtime_dom = dom;
        Object.defineProperty(dom.window.navigator, 'userAgent', {
            value: USER_AGENT,
            configurable: true
        });
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            location: dom.window.location,
            origin: dom.window.origin
        });

        Object.defineProperty(globalThis, 'navigator', {
            value: dom.window.navigator,
            configurable: true,
            writable: true
        });

        let key = REQUEST_KEY;
        let req_UA = USER_AGENT;
        let { challenge, eacrToken } = await fetchHomepageAttestation(dom);
        let challenge_source = challenge?.bgChallenge ? 'homepage' : undefined;

        if (
            !challenge?.bgChallenge &&
            (eacrToken || allow_fallback || process.env.ALLOW_UNBOUND_ATT_FALLBACK === 'true')
        ) {
            try {
                const payload = {
                    context: {
                        client: {
                            clientName: WEB_CLIENT_NAME,
                            clientVersion: WEB_CLIENT_VERSION
                        }
                    },
                    engagementType: 'ENGAGEMENT_TYPE_UNBOUND'
                };

                if (eacrToken) payload.eacrToken = eacrToken;

                const att_res = await fetch(`${YT_BASE}/youtubei/v1/att/get?prettyPrint=false`, {
                    method: 'POST',
                    headers: {
                        accept: '*/*',
                        'content-type': 'application/json',
                        'user-agent': USER_AGENT,
                        'x-goog-api-key': INNERTUBE_API_KEY
                    },
                    body: JSON.stringify(payload)
                });

                if (!att_res.ok) throw new Error(`att/get returned ${att_res.status}`);

                const attestation = await att_res.json();

                if (!attestation?.bgChallenge) throw new Error('could not get challenge from att/get');

                challenge = { bgChallenge: attestation.bgChallenge };
                challenge_source = eacrToken ? 'att_eacr' : 'att_unbound';
            } catch {
                challenge = undefined;
                challenge_source = undefined;
            }
        }

        if (!challenge?.bgChallenge && (allow_fallback || process.env.ALLOW_WAA_CREATE_FALLBACK === 'true')) {
            try {
                const waa_res = await fetch(buildURL('Create', false), {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json+protobuf',
                        'x-goog-api-key': INNERTUBE_API_KEY,
                        'x-user-agent': 'grpc-web-javascript/0.1',
                        'user-agent': USER_AGENT
                    },
                    body: JSON.stringify([key])
                });

                if (!waa_res.ok) throw new Error(`WAA Create returned ${waa_res.status}`);

                challenge = parse_waa_challenge(await waa_res.json());
                if (challenge?.bgChallenge) {
                    challenge_source = 'waa_create';
                }
            } catch {
                challenge = undefined;
                challenge_source = undefined;
            }
        }

        if (!challenge?.bgChallenge && (allow_fallback || process.env.ALLOW_TV_CONFIG_FALLBACK === 'true')) {
            try {
                const res = await fetchTextHttps(TV_CONFIG, {
                    accept: '*/*',
                    'user-agent': TV_USER_AGENT
                });
                if (!res.ok) throw new Error(`tv_config returned ${res.status}`);
                if (!res.text.startsWith(')]}')) throw new Error('invalid yt tv config response');

                const json = JSON.parse(res.text.slice(4));

                challenge = json.challengeParams?.R ? JSON.parse(json.challengeParams.R) : undefined;
                key = json.challengeRequestKey || key;
                if (challenge?.bgChallenge) {
                    challenge_source = 'tv_config';
                    req_UA = TV_USER_AGENT;
                    Object.defineProperty(dom.window.navigator, 'userAgent', {
                        value: TV_USER_AGENT,
                        configurable: true
                    });
                }
            } catch {
                challenge = undefined;
                challenge_source = undefined;
            }
        }

        if (!challenge?.bgChallenge) throw new Error('Could not get botguard challenge');

        const interpreterUrl =
            challenge.bgChallenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
        const inlineInterpreter =
            challenge.bgChallenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
        let interpreter = inlineInterpreter || '';
        if (!interpreter && interpreterUrl) {
            const interp_res = await fetch(`https:${interpreterUrl}`, {
                headers: { 'user-agent': req_UA }
            });
            if (!interp_res.ok) throw new Error(`BotGuard interpreter returned ${interp_res.status}`);
            interpreter = await interp_res.text();
        }

        if (!interpreter) throw new Error("couldn't load botguard interpreter");

        new Function(interpreter)();

        runtime_global_name = challenge.bgChallenge.globalName;
        runtime_vm_ref = globalThis[runtime_global_name];

        const client = await create_bg({
            program: challenge.bgChallenge.program,
            globalName: runtime_global_name,
            globalObject: globalThis
        });
        runtime_client = client;

        const endpoint = buildURL('GenerateIT', useYouTubeAPI);
        const isWebAttested = challenge_source === 'homepage' || challenge_source === 'att_eacr';
        const maxItAttempts = isWebAttested ? 4 : 1;

        let signals = [];
        let integrity_token;
        let estimated_ttl_secs;
        let mint_refresh_threshold;
        let websafe_fallback_token;

        for (let itAttempt = 0; itAttempt < maxItAttempts; itAttempt++) {
            if (itAttempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 100 * itAttempt));
            }
            signals = [];
            const res = await client.snapshot({ webPoSignalOutput: signals });

            const generate_options = (request_key) => ({
                method: 'POST',
                headers: {
                    'content-type': 'application/json+protobuf',
                    'x-goog-api-key': request_key,
                    'x-user-agent': 'grpc-web-javascript/0.1',
                    'user-agent': req_UA,
                    origin: YT_BASE,
                    referer: `${YT_BASE}/`
                },
                body: JSON.stringify([key, res])
            });

            const t_txt = await fetch(endpoint, generate_options(INNERTUBE_API_KEY));

            if (!t_txt.ok) throw new Error(`GenerateIT returned ${t_txt.status}`);

            [integrity_token, estimated_ttl_secs, mint_refresh_threshold, websafe_fallback_token] = await t_txt.json();

            if (!integrity_token || base64ToUint8(integrity_token).length <= 66) {
                break;
            }
        }

        const ttl = Number(estimated_ttl_secs);
        const maxMinterLifetimeMs = process.env.MAX_MINTER_TTL
            ? Number(process.env.MAX_MINTER_TTL)
            : 2 * 60 * 60 * 1000; // 2 hours max lifetime
        const fallbackLifetimeMs = process.env.FALLBACK_MINTER_TTL
            ? Number(process.env.FALLBACK_MINTER_TTL)
            : 15 * 60 * 1000; // 15 mins max lifetime for fallback extractors so homepage retries regularly
        const lifetimeCapMs = isWebAttested ? maxMinterLifetimeMs : Math.min(maxMinterLifetimeMs, fallbackLifetimeMs);
        const ttlMs = Math.max(1, (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) - 30) * 1000;
        expires = Date.now() + Math.min(ttlMs, lifetimeCapMs);

        const minter = await Minter.create(
            {
                integrity_token,
                mint_refresh_threshold,
                websafe_fallback_token,
                expiresAt: expires
            },
            signals,
            client,
            dom,
            runtime_global_name,
            runtime_vm_ref
        );
        minter.expiresAt = expires;

        if (build_gen !== minter_generation) {
            throw new Error('Minter session invalidated');
        }

        cur = minter;
        cur_source = challenge_source;

        return minter;
    })();
    try {
        return await minter_promise;
    } catch (error) {
        await disposeRuntime(runtime_dom, runtime_client, runtime_global_name, runtime_vm_ref);
        if (build_gen === minter_generation) {
            cur = undefined;
            cur_source = undefined;
            minter_promise = undefined;
            promise_allows_fallback = false;
            expires = 0;
        }
        throw error;
    }
}

export async function fetch_pot(contentBinding, useYouTubeAPI = true, ttl = null, options = {}) {
    let minter;
    try {
        const allow_fallback =
            typeof options?.allow_fallback === 'boolean'
                ? options.allow_fallback
                : !isVideoIdBinding(contentBinding) && !isLivingRoomIdBinding(contentBinding);
        minter = await getWebPo(useYouTubeAPI, { allow_fallback });
        const minter_expires = minter.expiresAt || expires;
        const token_expires =
            Number.isFinite(ttl) && ttl > 0 ? Math.min(minter_expires, Date.now() + ttl) : minter_expires;

        return {
            poToken: await minter.mintAsWebsafeString(contentBinding),
            contentBinding,
            ttl: Math.max(0, Math.floor((token_expires - Date.now()) / 1000)),
            minterSession: minter.integrityTokenData?.integrity_token || null
        };
    } catch (error) {
        if (!minter || cur === minter) {
            resetMinter();
        } else {
            minter.retire();
        }
        throw error;
    }
}

// this token only bridges the short period before yt moves sps from 2 to 3
// its generated per response cuz it contains the current time
export function createColdStartToken(contentBinding, clientState = 1) {
    const bytecode = new TextEncoder().encode(contentBinding);

    if (bytecode.length > COLD_START_MAX_BINDING_BYTES) return;

    const timestamp = Math.floor(Date.now() / 1000);
    const rand_keys = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];

    const header = rand_keys.concat(
        [0, clientState],
        [(timestamp >> 24) & 0xff, (timestamp >> 16) & 0xff, (timestamp >> 8) & 0xff, timestamp & 0xff]
    );

    const packet = new Uint8Array(2 + header.length + bytecode.length);

    packet[0] = 34;
    packet[1] = header.length + bytecode.length;
    packet.set(header, 2);
    packet.set(bytecode, 2 + header.length);

    const payload = packet.subarray(2);

    for (let i = 2; i < payload.length; i++) payload[i] = payload[i] ^ payload[i % 2];

    return Uint8ToBase64(packet, true);
}

export function decodeColdStartToken(token) {
    const packet = base64ToUint8(token);

    if (packet.length < 10 || packet[0] !== 34) throw new Error('invalid cold start token');

    const length = packet[1];
    if (packet.length !== length + 2 || length < 8) throw new Error('invalid cold start packet length');

    const payload = packet.slice(2);
    for (let i = 2; i < payload.length; i++) payload[i] = payload[i] ^ payload[i % 2];

    const timestamp = ((payload[4] << 24) | (payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0;

    return {
        contentBinding: new TextDecoder().decode(payload.subarray(8)),
        timestamp,
        unknownVal: payload[2],
        clientState: payload[3],
        keys: [payload[0], payload[1]],
        date: new Date(timestamp * 1000)
    };
}
