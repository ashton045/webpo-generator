// Real concurrency storm: N simultaneous /generate requests (all DIFFERENT bindings,
// so in-flight dedupe can't coalesce them) at the real server. Proves the
// overload gates: 256 pending cap, 32 queue, 1 worker — fast 503s, no hang,
// server healthy after the storm.
// Usage: node test/burst.real.js --n=1000
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
}));
const n = Number(args.n ?? 1000);
const PORT = 8102;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://localhost:${PORT}`;

const proc = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), LR_TTL: '0', WORKERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
proc.stdout.on('data', (d) => (serverLog += d));
proc.stderr.on('data', (d) => (serverLog += d));

const getJson = (p) => fetch(BASE + p).then((r) => r.json().catch(() => ({})));
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
    try {
        if ((await getJson('/ready')).status === 'ready') break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
}

// pre-warm: build the session so the storm measures concurrency, not session build
await fetch(BASE + '/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content_binding: 'dQw4w9WgXcQ' })
});

// n different 11-char video-id-shaped bindings (mintable, no dedupe)
const bindings = Array.from({ length: n }, (_, i) => 'a' + i.toString(36).padStart(10, '0').slice(0, 10));

const statuses = new Map();
const lat = [];
const stormStart = Date.now();
await Promise.all(
    bindings.map(async (b) => {
        const t = Date.now();
        try {
            const r = await fetch(BASE + '/generate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content_binding: b })
            });
            statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
            if (r.status === 200) lat.push(Date.now() - t);
            await r.text();
        } catch (e) {
            statuses.set('net|' + e.message, (statuses.get('net|' + e.message) ?? 0) + 1);
        }
    })
);
const stormMs = Date.now() - stormStart;

// server must still be healthy right after the storm
const after = await fetch(BASE + '/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content_binding: 'dQw4w9WgXcQ' })
});
const afterBody = await after.json().catch(() => ({}));

const s = lat.sort((a, b) => a - b);
console.log(`\n=== BURST: ${n} simultaneous distinct-binding requests, 1 worker ===`);
for (const [k, v] of [...statuses.entries()].sort((a, b) => b[1] - a[1])) console.log(`status ${k} : ${v}`);
console.log(`storm duration   : ${stormMs}ms (all ${n} requests finished)`);
if (s.length)
    console.log(
        `200-latency ms     : avg=${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(0)} p50=${s[Math.floor(s.length / 2)]} p95=${s[Math.floor(0.95 * s.length)]} max=${s[s.length - 1]}`
    );
console.log(`worker kills/timeouts in log: ${(serverLog.match(/worker exited|generation timed out/g) ?? []).length}`);
console.log(`server healthy after storm: ${after.status === 200 && afterBody.poToken ? 'YES (fresh mint ok)' : `NO (status ${after.status})`}`);

proc.kill('SIGTERM');
process.exit(0);
