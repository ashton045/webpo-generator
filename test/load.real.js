// Real load test: fires N real /generate requests per minute at the actual server
// (real BotGuard VM, real YouTube). Measures throughput, latency, errors, and how
// often the minter session rebuilds under that load (session rebuild = real API burst).
//
// Usage (from repo root):
//   node test/load.real.js --rate=100 --minutes=1
//   node test/load.real.js --rate=1000 --minutes=1 --concurrency=8
//   BASE=http://host:port node test/load.real.js --rate=100   # target an existing server
//
// Each request is a REAL mint (LR_TTL=0 on the spawned server, no cache).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
}));
const rate = Number(args.rate ?? 100); // requests per minute
const minutes = Number(args.minutes ?? 1);
const concurrency = Number(args.concurrency ?? 8);
const binding = args.binding ?? 'RJVVAMPlA-E='; // your real log binding
const PORT = 8100;
let BASE = process.env.BASE;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let serverLog = '';
let proc = null;
let spawned = false;

function getJson(p) {
    return fetch(BASE + p).then((r) => r.json().catch(() => ({})));
}

function pct(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
    if (!BASE) {
        spawned = true;
        BASE = `http://localhost:${PORT}`;
        proc = spawn('node', ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(PORT), LR_TTL: '0', WORKERS: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        proc.stdout.on('data', (d) => (serverLog += d));
        proc.stderr.on('data', (d) => (serverLog += d));
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            try {
                if ((await getJson(`http://localhost:${PORT}/ready`)).status === 'ready') break;
            } catch {}
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    const before = await getJson('/metrics/json');

    const lat = [];
    const errors = new Map(); // "status|error" -> count
    let ok = 0;
    let inFlight = 0;

    const fire = async () => {
        const t = Date.now();
        try {
            const r = await fetch(BASE + '/generate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content_binding: binding })
            });
            const b = await r.json().catch(() => ({}));
            if (r.status === 200 && b.poToken) {
                ok++;
                lat.push(Date.now() - t);
            } else {
                const key = `${r.status}|${b.error ?? 'no poToken'}`;
                errors.set(key, (errors.get(key) ?? 0) + 1);
            }
        } catch (e) {
            const key = `net|${e.message}`;
            errors.set(key, (errors.get(key) ?? 0) + 1);
        } finally {
            inFlight--;
        }
    };

    // Token bucket: exactly `rate/60` requests per second, capped at `concurrency` in-flight.
    const perSec = rate / 60;
    const end = Date.now() + minutes * 60 * 1000;
    let tokens = 0;
    while (Date.now() < end) {
        tokens += perSec * 0.25;
        const n = Math.floor(tokens);
        tokens -= n;
        for (let i = 0; i < n && Date.now() < end; i++) {
            while (inFlight >= concurrency) await new Promise((r) => setTimeout(r, 10));
            inFlight++;
            fire();
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    // drain in-flight
    let drain = 0;
    while (inFlight > 0 && drain++ < 300) await new Promise((r) => setTimeout(r, 100));

    const after = await getJson('/metrics/json');
    const total = ok + [...errors.values()].reduce((a, b) => a + b, 0);
    const s = lat.sort((a, b) => a - b);
    const retireEvents = (serverLog.match(/minter session retired/g) ?? []).length;
    const failedChallenges = (serverLog.match(/Could not get botguard/g) ?? []).length;

    console.log(`\n=== LOAD: ${rate} req/min x ${minutes}min, concurrency ${concurrency}, binding ${binding} ===`);
    console.log(`requests sent : ${total}`);
    console.log(`succeeded     : ${ok} (${((100 * ok) / Math.max(1, total)).toFixed(1)}%)`);
    console.log(`failed        : ${total - ok}`);
    for (const [k, v] of [...errors.entries()].slice(0, 8)) console.log(`  ${k} x${v}`);
    console.log(`latency ms    : avg=${(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(1)} p50=${pct(s, 50)} p95=${pct(s, 95)} p99=${pct(s, 99)} max=${s[s.length - 1] ?? 0}`);
    console.log(`mints/s       : ${(ok / (minutes * 60)).toFixed(2)}`);
    console.log(`generations   : ${before.generations} -> ${after.generations}   failures: ${before.failures} -> ${after.failures}`);
    console.log(`cache hit/miss: ${before.cacheHits} -> ${after.cacheHits} / ${before.cacheMisses} -> ${after.cacheMisses}`);
    console.log(`worker fails  : ${before.workerFailures} -> ${after.workerFailures}`);
    if (spawned) console.log(`session retires: ${retireEvents}   challenge-failed: ${failedChallenges}`);
    if (total - ok > 0 || failedChallenges > 0) {
        console.log('\n--- server log (last 1500 chars) ---\n' + serverLog.slice(-1500));
    }
}

try {
    await main();
} catch (e) {
    console.error('LOAD TEST ERROR:', e.message);
    console.log('\n--- server log ---\n' + serverLog);
} finally {
    if (proc) proc.kill('SIGTERM');
}
process.exit(0);
