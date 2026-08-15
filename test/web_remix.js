import { Innertube, Platform, UniversalCache } from 'youtubei.js';

const id = 'WPl10ZrhCtk';
const url = 'http://127.0.0.1:8080';
const client = "YTMUSIC";

Platform.shim.eval = async (data) => new Function(data.output)();

const res = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({content_binding: id})
});

if (!res.ok) throw new Error(res);

const d = await res.json();
console.log(d)

const innertube = await Innertube.create({client_type: client, cache: new UniversalCache(true)});
const info = await innertube.getBasicInfo(id, {client});
const format = info.chooseFormat({ quality: 'best', type: 'audio', po_token: d.poToken });
const u = `${await format.decipher(innertube.session.player)}&pot=${encodeURIComponent(d.poToken)}`;

console.log(u);
