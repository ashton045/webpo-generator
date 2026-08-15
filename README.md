# webpo-generator

An http remote service to generate poTokn (proof of origin Tokken). This service mints poToken by either videoId or visitorId.

## Table of Contents
- [Introduction](#introduction)
- [Getting Started](#getting-started)
    - [Configuration](#configuration)
    - [Lavalink](#lavalink)
    - [Hosting](#hosting)
        - [Docker Setup](#docker-setup)
        - [Direct Setup](#direct-setup)
    - [Auth](#auth)
    - [Endpoints](#endpoints)
    - [A Few Notes](#a-few-notes)
      - [What is a Botguard?](#what-is-botguard) 
      - [How a WebPo is generated?](#how-a-webpo-token-is-generated)

## Introduction
The core logics of botguard attestation solver were taken from [LuanRT/BgUtils](https://github.com/LuanRT/BgUtils). This service is now required to get playable youtube streams, as by 2026 youtube now enforces PoT to be minted in google video service or gvs for certain innertube clients, unlike legacy pot system, now we need to generate new pots per video, annoying right :). Researches done by [LuanRT](https://github.com/LuanRT) are as follow:
- [Research](https://github.com/LuanRT/BgUtils#research)
    - [Initialization Process](https://github.com/LuanRT/BgUtils#initialization-process)
    - [Retrieving Integrity Token](https://github.com/LuanRT/BgUtils#retrieving-integrity-token)
    - [Minting WebPO Tokens](https://github.com/LuanRT/BgUtils#minting-webpo-tokens)
    - [When to Use a PO Token](https://github.com/LuanRT/BgUtils#when-to-use-a-po-token)
        - [Token Types](https://github.com/LuanRT/BgUtils#token-types)


> [!caution]
> As mentioned earlier this is also not a silver bullet solution providing a `PoToken` does not guarantee bypassing the `403` errors, but it may help your traffic look legimate.
      
## Getting Started
### Lavalink
Attach this config in your youtube-source plugin:
```yaml
plugins:
  youtube:
    remotePot:
      url: "http://localhost:8080"
```

## Configuration
- **HOST** - listen address; falls back to IPv4 when needed.
- **PORT** - http port, default is `8080`
- **WORKERS** - no of workers count, default is `1`
- **QUEUE_SIZE** - max queued generation jobs, default is `32`
- **MAX_PENDING_REQUESTS** - max generation requests in progress, default is `256`
- **REQUEST_TIMEOUT** - timeout in ms, default is `30000`
- **CACHE_SIZE** - max cached bindings, default is `100`
- **VISITOR_TTL** - visistorId ttl in ms, default is `36000000`

## Hosting
### Docker Setup

```bash
git clone https://github.com/ashton318/webpo-generator.git

cd webpo-generator

docker compose up
```

> [!Note]
> To refresh a published image, set `WEBPO_IMAGE` and run `scripts/update-compose.sh` (or `scripts/update-compose.ps1` on Windows).

### Direct Setup

```bash
git clone https://github.com/ashton318/webpo-generator.git

cd webpo-generator

npm i 

npm start
```

## Auth
You can set a `token` in your environment variable to restrict your service access upto you. 
```json
{
  "Authorization": "can_you_pass_it"
}
```
**Docker**: edit your environment variables in `compose.yml` and uncomment the `API_TOKEN=can_you_pass_it`\
**Direct**: create a `.env` and put `API_TOKEN=can_you_pass_it`

### Lavalink Config
```yaml
plugins:
  youtube:
    remotePot:
      url: "http://localhost:8080",
      pass: "can_you_pass_it" # here goes your service pass
```

## Endpoints


### `POST /generate`
Request Body:
```json
{
  "content_binding": "",
  "coldToken": false
}
```

Expect response:

```json
{
  "poToken": "...",
  "contentBinding": "..."
}
```
if coldToken was set as `true`:

```json
{
  "poToken": "...",
  "contentBinding": "...",
  "coldStartToken": "..."
}
```
> [!Note]
> `poToken` is the real content bound token. `coldStartToken` is a per response bootstrap token for yt's temporary `sps=2`.

### `POST /decode_cold_start`

Decodes a cold start token. This endpoint does not mint, cache, or validate the token against yt.

```json
{
  "token":"..."
}
```

> [!Note]
> Prometheus metrics include htt request totals, response totals, latency histograms, generation outcomes, cache hits/misses, pending requests, queue depth, worker count, and nodejs runtime metrics.

## A few notes

The first prototype i developed was [webpo_generator](https://github.com/ftrapture/webpo_generator). I learned about botguard and its environment through a lot of tests and trial and error.
I was able to get playback working with a few innertube clients: `WEB_REMIX`, `MWEB`, and `TVHTML5_SIMPLY`. `WEB_REMIX` and `MWEB` use content bound webpo tokens, their tokens are minted with the videoId, so a token from one video should not be reused for another video.
`TVHTML5_SIMPLY` uses the older session bound technique, where the token is bound to `visitorData`. A visitor bound token can be reused for multiple videos while the visitor data and token are still valid eg are available in the `tests/` folder using `youtubei.js`.

### What is BotGuard?

Botguard is googl's client side anti abuse environment which runs a challenge program, checks the runtime, and produces attestation signals yt can use those signals to decide whether a request looks like legitimate or nah.

An attestation is not the final PoT btw cuz it's evidence produced by the botguard runtime and sent to google's WAA service for evaluation.

### How a WebPO token is generated

The service can obtain a botguard challenge through 4 fallback methods. They are ordered from highest success rates to lowest:

1. **yt homepage** - The service fetches the initial/home page, extracts `ytcfg.set(...)`, installs the `ytcfg` into the virtual page, and reads the `window.ytAtN(...)` challenge.
2. **tv config** - fetches `tv_config`, which contains challenge data directly and does not depend on the homepage event data.
3. **innertube att** - sends a POST request to `/youtubei/v1/att/get?prettyPrint=false` with a `WEB` client ctx and receives the botguard challenge directly.
4. **WAA Create RPC** - sends the request key to Google's WAA `Create` endpoint. The response can be encoded, so the service decodes it before reading the program, global name, and interpreter infos.

The service also extracts the current innertube api key from yt's `sw.js`. The builtin key remains available as a fallback because less requesting makes yt to sus less as well :).

After the challenge is fetched and then it loads the interpreter js.

The interpreter is executed with `new Function()` inside a `JSDOM` based mimicked browser env. The bytecode program is then passed into the vm.

The snapshot collects the runtime signals and produces the botguard response. The service sends that response to the `GenerateIT` endpoint together with the request key. GenerateIT returns an `integrity token` and its estimated lifetime.

The integrity token is passed to the `WebPO minter` function returned by botguard. The minter then receives the PoToken:

```text
content binding → botguard minter → WebPO bytes → websafe Base64 PoT
```

The content binding is either a video id or visitor data. Real PoT results are cached according to the binding type and lifetime. Cold start tokens are optional bootstrap values for the temporary `sps=2` state.\
:)
