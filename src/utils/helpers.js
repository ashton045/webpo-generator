
import { BASE64_MAP, GOOGLE_API_BASE, REG_FOR_BASE64, YT_BASE } from './constants.js';

export function base64ToUint8(base64) {
    const base64Mod = base64.replace(REG_FOR_BASE64, (match) => BASE64_MAP[match]);
    return new Uint8Array([...atob(base64Mod)].map((char) => char.charCodeAt(0)));
}

export function Uint8ToBase64(u8, base64url = false) {
    const result = btoa(String.fromCharCode(...u8));
    return base64url ? result.replace(/\+/g, '-').replace(/\//g, '_') : result;
}

export function buildURL(endpoint, use_api = true) {
    return `${use_api ? YT_BASE : GOOGLE_API_BASE}/${use_api ? 'api/jnn/v1' : '$rpc/google.internal.waa.v1.Waa'}/${endpoint}`;
}

export function parse_json(looseJson) {
    let jsonStr = looseJson.replace(/,\s*([\]}])/g, '$1')
    .replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1')
    .replace(/'((?:[^'\\]|\\[\s\S])*)'/g, (_match, innerStr) => {
        return `"${innerStr.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`;
    });

    let parsedData;
    try {
        parsedData = JSON.parse(jsonStr);
    } catch (err) {
        try {
            const reg = jsonStr.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');
            parsedData = JSON.parse(reg);
        } catch {
            throw err;
        }
    }

    const decodeHexEscapes = (value) => {
        return value.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
        });
    };

    const normalizeValue = (value) => {
        if (typeof value === 'string') {
            const decodedValue = decodeHexEscapes(value);
            const trimmed = decodedValue.trim();

            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    return normalizeValue(JSON.parse(decodedValue));
                } catch {
                    return decodedValue;
                }
            }

            return decodedValue;
        }

        if (Array.isArray(value)) {
            return value.map(normalizeValue);
        }

        if (value && typeof value === 'object') {
            for (const key in value) {
                value[key] = normalizeValue(value[key]);
            }
        }

        return value;
    };

    return normalizeValue(parsedData);
}