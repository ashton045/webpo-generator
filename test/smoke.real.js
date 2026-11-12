// REAL smoke test: boots the actual server (real BotGuard VM, real YouTube) and
// mints real PoTs. Not a mock. Run from the repo root:
//   node test/smoke.real.js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const BASE = `http://localhost:${PORT}`;

// The exact living-room binding from your Lavalink logs (04:35 / 04:57 failure pair).
const LR_BINDING = 'RJVVAMPlA-E=';
// A real 11-char video id for the video-token path (any public id works).
const VIDEO_ID = 'dQw4w9WgXcQ';

let failures = 0;
function ok(cond, label, extra = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
    if (!cond) failures++;
}

function getJson(p) {
    return fetch(BASE + p).then((r) => r.json().catch(() => ({})));
}
function postGenerate(body) {
    return fetch(BASE + '/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

const server = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), LR_TTL: '0', WORKERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitFor(fn, ms, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if (await fn()) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log('server log so far:\n' + serverLog);
    throw new Error('timed out waiting for: ' + what);
}

try {
    await waitFor(async () => (await getJson('/health')).status === 'ok', 20000, 'server /health');
    await waitFor(async () => (await getJson('/ready')).status === 'ready', 10000, 'worker ready');
    ok(true, 'server up + worker ready');

    // --- REAL mint #1: living-room binding, the one from your failure logs ---
    const r1 = await postGenerate({ content_binding: LR_BINDING });
    ok(r1.status === 200, 'POST /generate (living-room) returns 200', `status=${r1.status}`);
    ok(typeof r1.body.poToken === 'string' && r1.body.poToken.length >= 20, 'real poToken minted', `len=${r1.body.poToken?.length}`);
    ok(r1.body.contentBinding === LR_BINDING, 'binding echoed back', r1.body.contentBinding);
    ok(Number.isFinite(r1.body.ttl) && r1.body.ttl > 0, 'ttl present', `ttl=${r1.body.ttl}s`);
    const token1 = r1.body.poToken;

    // --- REAL mint #2: same binding again. With LR_TTL=0 the cache must NOT
    //     serve token1 back — a fresh mint must produce a different string. ---
    const r2 = await postGenerate({ content_binding: LR_BINDING });
    const token2 = r2.body.poToken;
    ok(r2.status === 200 && typeof token2 === 'string' && token2.length >= 20, 'second mint ok', `status=${r2.status}`);
    ok(token1 !== token2, 'LR_TTL=0 -> second mint is a NEW token (no cache reuse)', `t1==t2:${token1 === token2}`);

    // --- REAL mint #3: video-id path (different cache) also works end-to-end ---
    const r3 = await postGenerate({ content_binding: VIDEO_ID });
    ok(r3.status === 200 && typeof r3.body.poToken === 'string' && r3.body.poToken.length >= 20, 'video-id mint ok', `status=${r3.status}`);

    // --- metrics confirm: generations went up, cache did not serve the LR token ---
    const m = await getJson('/metrics/json');
    ok(m.generations >= 3, 'metrics.counted real generations', `generations=${m.generations}`);
    ok(m.failures === 0, 'no generation failures', `failures=${m.failures}`);

    console.log('\n-- sample real token (truncated) --');
    console.log(token1.slice(0, 40) + '...  ttl=' + r1.body.ttl + 's');
    console.log('tokens distinct across plays:', token1 !== token2);

    if (failures === 0) console.log('\nSMOKE TEST PASSED — real BotGuard minting works end-to-end with the patch.');
    else console.log(`\nSMOKE TEST FAILED — ${failures} check(s) failed.`);
} catch (e) {
    console.error('\nSMOKE TEST ERROR:', e.message);
    failures++;
    console.log('\nserver log:\n' + serverLog);
} finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
}
process.exit(failures === 0 ? 0 : 1);
