# webpo-generator

An http remote service to generate poToken (proof of origin Token). This service mints poToken by either videoId or visitorId.

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

## Public instance
Use `https://pot.ashtongg.me` it's the public hosted server of webpo-generator. It has a ratelimit of `10 requests/sec`. 
I cannot give you the guarantee of full uptime but i'll do my best to keep it up at scale.

## Configuration
- **HOST** - listen address; falls back to IPv4 when needed.
- **PORT** - http port, default is `8080`
- **WORKERS** - no of workers count, default is `1`
- **QUEUE_SIZE** - max queued generation jobs, default is `32`
- **MAX_PENDING_REQUESTS** - max generation requests in progress, default is `256`
- **REQUEST_TIMEOUT** - timeout in ms, default is `30000`
- **CACHE_SIZE** - max cached bindings, default is `100`
- **VISITOR_TTL** - visistorId ttl in ms, default is `600000`
- **MAX_CACHE_TTL** - max `videoId` token cache ttl in ms, default is `21600000` (`6h`)
- **LR_TTL** - `livingRoomPoTokenId` cache ttl in ms, default is `3600000` (`1h`)
- **MAX_MINTER_TTL** - max cached minter lifetime in ms, default is `7200000` (`2h`)
- **FALLBACK_MINTER_TTL** - max fallback minter lifetime in ms, default is `900000` (`15m`)
- **ALLOW_UNBOUND_ATT_FALLBACK** - allow unbound `att/get` for `videoId` bindings when `true`, default `false`
- **ALLOW_WAA_CREATE_FALLBACK** - allow WAA `Create` for `videoId` bindings when `true`, default `false`
- **ALLOW_TV_CONFIG_FALLBACK** - allow `tv_config` for `videoId` bindings when `true`, default `false`

## IPv6/IPv4 bindings
it's very simple to bind your host to either IPv4/IPv6 interface is by setting `HOST=0.0.0.0` or `HOST=::` in your environment. To access the service locally use `http://localhost:8080` or `http://[::1]:8001` or insert an actual IPv4/IPv6 to get access from another device.

## Hosting
### Docker Setup

```bash
git clone https://github.com/ashton045/webpo-generator.git

cd webpo-generator

docker compose up
```

> [!Note]
> To pull the latest image and restart the stack after updates: run `scripts/update-compose.sh` (or `scripts/update-compose.ps1` on Windows).

### Direct Setup

```bash
git clone https://github.com/ashton045/webpo-generator.git

cd webpo-generator

npm i 

npm start
```

## Auth
You can set a `token` in your environment variable to restrict your service access upto you only. 
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
      url: "http://localhost:8080"
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
  "contentBinding": "...",
  "ttl": 599
}
```
if coldToken was set as `true`:

```json
{
  "poToken": "...",
  "contentBinding": "...",
  "coldStartToken": "...",
  "ttl": 599
}
```
> [!Note]
> `poToken` is the real content bound token. `coldStartToken` is a per response bootstrap token for yt's temporary `sps=2`. `ttl` is the remaining token validity in seconds.

### `POST /decode_cold_start`

Decodes a cold start token. This endpoint does not mint, cache, or validate the token against yt.

```json
{
  "token":"..."
}
```

### `POST /invalidate`

Invalidates cached tokens and minter state. Accepts an optional JSON body:
```json
{
  "po_token": "...",
  "content_binding": "..."
}
```
When `po_token` or `content_binding` is provided, only the matching cached entry and the worker minter session that minted it are invalidated (leaving other active minters and unrelated cached tokens intact). When called with an empty body (`{}`), it clears all caches across workers.

Expect response:
```json
{
  "success": true,
  "message": "..."
}
```

### `GET /minter_cache`

Returns `current_minter_session` (or `null`) and the active `workers` count.

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

The service can obtain a botguard challenge through 4 methods, ordered from highest compatibility to lowest:

1. **yt homepage** - The service fetches the home page (with `SOCS=CAI` cookie and a `250ms` retry if needed), extracts `ytcfg.set(...)` and `EVENT_ID` into the virtual page, and reads the challenge and `eacrToken` from `window.ytAtN(...)`, `window.ytAtR`, or `initialAttestationDataJson`. Works for all bindings.
2. **innertube att** - sends a `POST` request to `/youtubei/v1/att/get?prettyPrint=false` with a `WEB` client ctx (and `eacrToken` when available) to receive the botguard challenge directly. Calling it without `eacrToken` only runs as a fallback for `non videoId` bindings (unless overridden).
3. **WAA Create RPC** - sends the request key to Google's `WAA Create` endpoint (`$rpc/google.internal.waa.v1.Waa/Create`) as a fallback for `non videoId` bindings (unless overridden). The response can be encoded, so the service decodes it before reading the program, global name, and interpreter info.
4. **tv config** - fetches `/tv_config` via `node:https` for `non videoId` bindings (unless overridden), which contains challenge data directly and does not depend on homepage event data.

Fallback minters (unbound `att/get`, `WAA Create`, `tv_config`) are never reused for `videoId` requests. If a `videoId` request comes in while a fallback minter is cached, the service resets it and fetches a `videoId` compatible challenge (`yt homepage` or `eacrToken` with `att/get`) instead.

The hardcoded innertube key is being used in here for certain requests, as that key has been registered for google's private apis.

After the challenge is fetched, it loads the interpreter js using the same user agent.

The interpreter is executed with `new Function()` inside a `JSDOM` based mimicked browser env (with a matching `navigator.userAgent`, or `TV_USER_AGENT` for `tv_config`). The bytecode program is then passed into the vm.

The snapshot collects the runtime signals and produces the botguard response. The service sends that response to the `GenerateIT` endpoint together with the request key. GenerateIT returns an `integrity token`, its estimated lifetime, and a mint refresh threshold.

The integrity token is passed to the `WebPO minter` function returned by botguard, which stays cached up to its TTL. The minter then produces the PoToken:

```text
content binding → botguard minter → WebPO bytes → websafe Base64 PoT
```

The content binding is a `videoId`, a `livingRoomPoTokenId`, or `visitorData`. Real pot results are cached for videoIds, living room pot Ids, and internal server generated visitor data according to their lifetime, while explicit visitor data is not cached and entries expire by TTL or get evicted on targeted `/invalidate`. Cold start tokens are optional bootstrap values for the temporary `sps=2` state.

Thanks to [Deivu](https://github.com/Deivu) helped populating the sources :)
