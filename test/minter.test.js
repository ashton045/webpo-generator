import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// botguard.js imports jsdom; stub it, only the mint path is exercised
const JSDOM = `export class JSDOM { constructor() { this.window = { document: {}, location: {}, close() {} }; this.window.navigator = {}; } }`;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === 'jsdom')
            return { url: 'data:text/javascript,' + encodeURIComponent(JSDOM), shortCircuit: true };
        return next(specifier, context);
    }
});

let itn = 0;
let mint = async () => new Uint8Array(24).fill(7);

globalThis.__testMint__ = (args, res) => {
    args[2].push(async () => () => mint());
    res(null);
};

globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/att/get'))
        return {
            ok: true,
            json: async () => ({
                bgChallenge: {
                    program: 1,
                    globalName: '__fakevm__',
                    interpreterJavascript: {
                        privateDoNotAccessOrElseSafeScriptWrappedValue:
                            'globalThis.__fakevm__ = { a: function (program, cb) { cb(function (res, args) { globalThis.__testMint__(args, res) }, function () {}, undefined, undefined); return [0]; } };'
                    }
                }
            })
        };
    if (u.includes('GenerateIT')) return { ok: true, json: async () => ['IT' + (itn++ + 1), 3600, 100, ''] };
    return { ok: true, text: async () => '' };
};

const { fetch_pot } = await import('../botguard.js');
const B = 'RJVVAMPlA-E=';

test('empty mint retires the session, next request rebuilds it', async () => {
    const ok = await fetch_pot(B);
    assert.equal(ok.minterSession, 'IT1');
    assert.ok(ok.poToken.length >= 20);

    mint = async () => undefined;
    await assert.rejects(() => fetch_pot(B), /empty token/);

    mint = async () => new Uint8Array(24).fill(9);
    assert.equal((await fetch_pot(B)).minterSession, 'IT2');
});

test('short token retires the session', async () => {
    mint = async () => new Uint8Array(4).fill(1);
    await assert.rejects(() => fetch_pot(B), /short token/);

    mint = async () => new Uint8Array(24).fill(2);
    assert.equal((await fetch_pot(B)).minterSession, 'IT3');
});

test('mint that throws retires the session', async () => {
    mint = async () => {
        throw new Error('vm dead');
    };
    await assert.rejects(() => fetch_pot(B), /vm dead/);

    mint = async () => new Uint8Array(24).fill(3);
    assert.equal((await fetch_pot(B)).minterSession, 'IT4');
});
