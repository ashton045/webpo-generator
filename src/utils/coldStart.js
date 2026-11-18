import { COLD_START_MAX_BINDING_BYTES } from './constants.js';
import { base64ToUint8, Uint8ToBase64 } from './helpers.js';

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
