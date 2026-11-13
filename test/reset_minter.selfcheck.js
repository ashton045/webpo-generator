// Self-check for the minter self-heal fix in botguard.js (fetch_pot / mintAsWebsafeString).
// Run: node test/reset_minter.selfcheck.js
// Proves: after a failed or empty mint, the next request rebuilds the minter session
// by itself instead of reusing a broken one (the bug that used to require a manual restart).
// Drives the real fetch_pot -> getWebPo path with a fake network; no real YouTube calls.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// botguard.js imports jsdom; stub it (this check never touches a real DOM).
const JSDOM_STUB = `
export class JSDOM {
    constructor() {
        this.window = { document: {}, location: {}, close() {} };
        this.window.navigator = {};
    }
}
`;

registerHooks({
    resolve(specifier, context, next) {
        if (specifier === 'jsdom') {
            return { url: 'data:text/javascript,' + encodeURIComponent(JSDOM_STUB), shortCircuit: true };
        }
        return next(specifier, context);
    }
});

let itn = 0;
let doMint = async () => new Uint8Array(30).fill(7);

globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/att/get')) {
        return {
            ok: true,
            json: async () => ({
                bgChallenge: {
                    program: 1,
                    globalName: '__fakevm__',
                    interpreterJavascript: {
                        privateDoNotAccessOrElseSafeScriptWrappedValue:
                            'globalThis.__fakevm__ = { a: function (program, cb) { var snap = function (res, args) { globalThis.__testMint__(args, res) }; cb(snap, function () {}, undefined, undefined); return [0]; } };'
                    }
                }
            })
        };
    }
    if (u.includes('/api/jnn/v1/GenerateIT')) {
        itn++;
        return {
            ok: true,
            json: async () => ['IT' + itn, 3600, 100, 'fallback']
        };
    }
    return { ok: true, text: async () => '' }; // empty home page: no challenge, forces att/get path
};

// Phase 1 (webPoSignalOutput): push the minter factory. getMinter(token) must return a mint function.
globalThis.__testMint__ = (args, res) => {
    args[2].push(async () => (bindingBytes) => doMint(bindingBytes));
    res(null);
};

const { fetch_pot } = await import('../botguard.js');

// 1. Happy path: session IT-1, token = base64url of the minted bytes.
const ok = await fetch_pot('RJVVAMPlA-E=');
const expected = btoa(String.fromCharCode(...new Uint8Array(30).fill(7))).replace(/\+/g, '-').replace(/\//g, '_');
assert.equal(ok.poToken, expected, 'token is the minted bytes, base64url');
assert.equal(ok.minterSession, 'IT1');
assert.equal(itn, 1);

// 2. Mint throws -> fetch_pot rejects AND retires the broken session.
doMint = async () => {
    throw new Error('vm dead');
};
await assert.rejects(() => fetch_pot('RJVVAMPlA-E='), /vm dead/);
assert.equal(itn, 1, 'no rebuild during the failed call itself');

// 3. Core of the fix: the next request auto-rebuilds a fresh session (no manual restart).
doMint = async () => new Uint8Array(30).fill(9);
const ok2 = await fetch_pot('RJVVAMPlA-E=');
assert.equal(ok2.minterSession, 'IT2', 'fresh session after a failed mint');
assert.equal(itn, 2);

// 4. Empty mint (VM returned nothing) -> treated as a failed mint, session retired too.
doMint = async () => undefined;
await assert.rejects(() => fetch_pot('RJVVAMPlA-E='), /mint returned no token data/);
doMint = async () => new Uint8Array(30).fill(11);
const ok3 = await fetch_pot('RJVVAMPlA-E=');
assert.equal(ok3.minterSession, 'IT3', 'fresh session after an empty mint');
assert.ok(ok3.poToken.length >= 20);

console.log('self-check passed: failed/empty mints now auto-rebuild the minter session (no restart needed)');
process.exit(0);
