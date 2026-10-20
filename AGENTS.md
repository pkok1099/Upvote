# AGENTS.md — Upvote (vote-load / rate-limiter test tool)

## What this repo is

A Node.js CLI that simulates mass voting against *your own* comic-web voting
server, to validate pre-launch behavior: per-IP rate-limiter accuracy, vote
overlap detection, and server throughput under load. It is **not** a library —
there is no public API surface; everything is driven through the CLI.

Code comments and docs are in Indonesian; identifiers/logic are standard JS.

## Environment constraints (read first)

- **Node >= 18** (uses native `fetch`). Repo runs on Node v26 here.
- **External proxies.** Any SOCKS5 / HTTP CONNECT proxy on `127.0.0.1:<port>`
  works (e.g. wireproxy exposing WG tunnels). The tool itself only speaks
  SOCKS5 / HTTP CONNECT to those proxies; it does not launch them.

## Commands

```bash
# Main runner (the actual vote engine)
node upvote-core.js --id <uuid|chapter/<uuid>|url> --max <n> [opts]

# Sanity self-check (no framework)
node selfcheck.js

# wpmulti launcher (build+start wpmulti, run votes with --proxy-replicas auto, stop)
./wpmulti.sh <conf-dir> [votes] [delay-ms] [target-id] [opts...]
```

## wpmulti integration (`/home/ubuntu/wpmulti-lib`)

`wpmulti` runs N WireGuard sessions in one process behind a single SOCKS5/HTTP
listener. It route-selects **per flow (5-tuple)** with sticky affinity, so one
TCP connection always maps to one egress IP. To use all N IPs:

- `--no-keepalive` — otherwise one reused connection pins one flow → one IP.
- `--proxy-replicas <n|auto>` — parallel lanes = parallel flows. `auto` reads
  the live session count from wpmulti `/debug/sessions`.
- `modules/wpmulti.js` — `detectSessions()` probes the debug endpoint;
  `countSessions()` parses the JSON. `modules/proxy-loader.js` `init()` is async
  for this reason (called from `upvote-core.js` before `spamVote`).

## Core runner options (non-obvious ones)

From `modules/cli.js` `parseArgs` (CLI parsing + IPv6). Defaults come from
root `config.js`, then `DEFAULTS` fallback in `modules/cli.js`. README omits
`--api-url`, which **does** exist:

| Flag | Meaning / gotcha |
|------|------------------|
| `--id`, `--url` | Plain UUID, `chapter/<uuid>`, or full URL → normalized to `chapter/<uuid>` (`util.extractChapterId`). Invalid input → process exit 1. Comma-separated or repeated (`--id a,b` / `--id a --id b`) = **multi-target**: workers rotate chapters round-robin; each chapter (× each `--vote-types` value) has its own counter, tracked in `rt.perTarget` (→ per-ID / per-counter summary tables). `--max`/`--count-real` goals stay **aggregate** across all counters. |
| `--api-url` | Full vote API URL (not in README). Default `http://127.0.0.1:8000/api/article?lang=en`. **Tests use `https://commento.shngm.io/api/article?lang=en`** via an env default in the test scripts. |
| `--proxy-dir` | Folder of `wgcf-*.conf`; each conf's `BindAddress` port becomes a `socks5://127.0.0.1:<port>` proxy. |
| `--global-concurrency 0` | Default = **unlimited**, each proxy fully independent. Any N>0 installs a cross-proxy semaphore that *queues* excess requests (does not block event loop). |
| `--chapter-concurrency <n>` | Per-**counter** (`(chapter,type)`) semaphore (`semaphore.js` `acquireChapterSlot`/`releaseChapterSlot`, `rt.chapterSlots`). Caps concurrent writes to one counter. Server does non-atomic read-modify-write on each counter → concurrent writes to the *same* counter cause lost updates (silent drop). Conversion is governed by **ratio C/K** (concurrent req ÷ number of independent counters), not by C or K alone: measured C/K=1 → 98-99%, C/K=3 → 91-97%, C/K=8 → 90%. With multi-ID × multi-type, the number of counters is `K×T`. Safe: **C/K ≤ 2**. `0` = no cap. The runtime limit lives in `rt.chapterLimit` (mutable) so auto-tune can move it mid-run. |
| `--auto-tune` | Closed-loop controller (`modules/autotune.js`) that moves `rt.chapterLimit` to hold `entered/sent` ≥ `--auto-tune-target` (default 90%). Slow-start (×2/window) to find the knee, multiplicative backoff (×0.5, requires **2 consecutive** bad windows to avoid noise), then parks at a learned safe `ceiling` and only re-probes upward every `--auto-tune-probe` safe windows. Conversion is read per-window from `rt.state.sent`/`entered` deltas; window conversion is clamped to 100% (organic votes can push it above). Bounded by `--auto-tune-max`. Measured on the real server: 4 IDs / 64 replicas, no gate → 74.5% conv; `--auto-tune` → 97% conv. |
| `--delay` | Per-proxy delay after a request; floor is 0. |
| `--jitter` | Added *random* 0..N ms per proxy so each proxy's rhythm is unique (mimics real users). |
| `--ipv6` | IPv6-only. **Side effect:** monkeypatches `dns.lookup` to family 6, `dns.setDefaultResultOrder("ipv6first")`. SOCKS5/HTTP-CONNECT path pre-resolves target to an IPv6 literal (`resolveIPv6`) so the proxy can't pick IPv4. |
| `--proxy-replicas <n|auto>` | Duplicate each proxy into N lanes (interleaved). One lane = one keep-alive connection, so a single round-robin endpoint can fan out to N backend IPs. `auto` = read active session count from wpmulti `/debug/sessions`. |
| `--wpmulti-debug <addr>` | Debug addr for `auto` (default `127.0.0.1:2081`). |
| `--no-keepalive` | Fresh connection per request. Required for per-**flow** round-robin proxies (`wpmulti`: N WG sessions behind one listener, flow→tunnel RR with sticky affinity). Keep-alive would pin one flow→one IP. |
| `--resume` | Continues from `.upvote-checkpoint.json`; budget recomputed as `max((COUNT_REAL ? maxRequests : maxVotes) - sent, 0)`. Restores `state.entered` + `seenReaction.max/entered`. |
| `--count-real` | Treats `--max` as **counted votes** (positive Δ of the voted counter via `util.applyReactionDelta`), not requests. Loop stops at `state.entered >= maxVotes` or `state.started >= maxRequests`. Confirmed: server silently drops votes while returning `errno:0`, so HTTP 200 ≠ counted. |
| `--max-requests <n>` | Safety request ceiling for `--count-real` (default `50 * maxVotes`). |
| `--vote-types <list>` | Comma-separated reaction types to vote, e.g. `reaction0,reaction1,reaction2` (default `reaction0`). **Each `(chapter,type)` pair is a separate server counter**, so adding types splits write pressure exactly like multi-ID: effective ratio becomes `C/(K×T)`. Measured on the real server (same total conc 36, 1 chapter, ~360 req): single `reaction0` = **54.9%**, `reaction0+1+2` = **76.8%**. Raises conversion but each type's rate drops 1/N. Invalid name (not `/^reaction\d+$/`) → exit 1. Workers rotate over the `chapters × types` cross-product; the per-counter semaphore and `rt.perTarget` are keyed by `` `${chapter}|${type}` ``. |

Exit codes (`runner.js:107`): `0` = target reached (checkpoint deleted),
`130` = stopped by SIGINT/SIGTERM (progress saved, `--resume` works),
`1` = target not reached.

## Architecture

Entry `upvote-core.js` wires modules via side effects on `require`:
1. `cli` parsed (CLI args parsed **at require time** — `parseArgs(process.argv)` runs immediately, and `--help`/`--unknown` call `process.exit`). `CONFIG` = `DEFAULTS` overlaid by root `config.js`.
2. `rt.budget = config.COUNT_REAL ? config.maxRequests : config.maxVotes`.
3. `proxy-loader` required → populates `rt.PROXIES` immediately.
4. `runner.spamVote()` runs the orchestration.

Shared mutable state lives in **one singleton object** `rt` (`modules/runtime.js`),
not in re-exported `let`s. Every module mutates `rt` so changes are visible
cross-module. **Do not** introduce module-local mutable globals for state that
other modules read — extend `rt` instead.

### Module map

| File | Responsibility |
|------|----------------|
| `upvote-core.js` | Entry; sets budget, loads proxies, runs `spamVote`. |
| `config.js` (root) | User-editable defaults (target, maxVotes, delay, apiUrl, proxy, proxyDir). |
| `modules/cli.js` | `DEFAULTS` + root `config.js` overlay, CLI parsing (require-time). Exports resolved scalars (`target`, `maxVotes`, `delay`, `apiUrl`, `PARALLEL`, `IPV6`, ...). |
| `modules/runtime.js` | The `rt` singleton: `state`, `LANES`, `budget`, dashboard vars, semaphore vars, `PROXIES`. |
| `modules/proxy-loader.js` | `init()` fills `rt.PROXIES` from `--proxy-dir` or `--proxy`/`HTTPS_PROXY`, then `replicate()`. For `--proxy-replicas auto`, probes wpmulti `/debug/sessions`. |
| `modules/lanes.js` | `buildLanes()` — one `lane` per proxy, each with its own `ProxyAgent`. `lane.cap = ceil(maxVotes / proxyCount)`. |
| `modules/tunnel.js` | `ProxyAgent` (custom keep-alive http/https agent), SOCKS5 handshake, HTTP CONNECT tunnel, TLS wrap for HTTPS targets. |
| `modules/vote.js` | `sendVoteViaAgent` (http/https.request) + `sendVoteDirect` (fetch), and `parseVoteResponse`. |
| `modules/worker.js` | `independentWorker` loop; `claimBudget`/`releaseBudget` (anti-overshoot); `attemptWithRetries`. |
| `modules/semaphore.js` | Global concurrency limiter (`acquireSlot`/`releaseSlot`) + per-chapter (`acquireChapterSlot`/`releaseChapterSlot`, reads `rt.chapterLimit`). |
| `modules/autotune.js` | `startAutoTune()` — periodic controller that moves `rt.chapterLimit` to hold vote conversion ≥ target (slow-start, backoff×0.5 after 2 bad windows, learned ceiling + rare probe). |
| `modules/checkpoint.js` | Async checkpoint save (temp-file + atomic rename, coalesces rapid saves) and sync flush; load on resume. |
| `modules/dashboard.js` | Real-time stats line + paginated per-proxy table; in-place TTY repaint. |
| `modules/util.js` | `sleep`, `normalizeProxy`, `extractChapterId`, `ipv6ToBytes`, `formatHostPort`. |
| `modules/wpmulti.js` | wpmulti integration: `countSessions`, `detectSessions` (`/debug/sessions`), `waitForPort`. |

### Diagnostic tools (repo root)

| File | Responsibility |
|------|----------------|
| `probe.js` | Standalone conversion probe: sends N votes via keep-alive to the real endpoint, prints per-request Δ of the voted counter. Sweeps `--concurrency`, `--interval`, multi-ID (`--id a,b`), and multi-type (`--vote-types a,b`). Used to derive the **C/K rule** and to measure the multi-type effect. Diagnostic only — not part of the CLI. |
| `rl-test-direct.js` / `rl-test.js` | Rate-limit tests (direct / via proxy). |
| `selfcheck.js` | Assert-based sanity checks, no framework. |

### Control / data flow

- `runner.spamVote()` → `buildLanes()` → `startStats()` → spawn one
  `independentWorker` per lane × `--concurrency`, `Promise.all` them.
- Each `independentWorker` loops: claim budget → `acquireSlot()` (if
  globalConcurrency>0) → `attemptWithRetries` → on success `state.sent++`,
  `saveCheckpointAsync()`; on fail `releaseBudget()` + `state.failed++` →
  sleep `delay + random(jitter)`. Loop breaks when: stopping, lane dead,
  `lane.sent >= lane.cap`, all lanes dead, or `state.started >= maxVotes*3`.
  With `--count-real`, breaks instead when `state.entered >= maxVotes`
  (delta of the voted counter) or `state.started >= maxRequests`; lane-cap and
  `maxVotes*3` no longer apply, and `rt.budget = maxRequests`.
- **Target rotation**: workers rotate across the `chapters × voteTypes`
  cross-product; the combo key is `` `${chapterPath}|${type}` ``.
- **Real conversion (`--count-real`)**: `rt.perTarget[<chapter>|<type>] = {chapter, type, max, entered, sent}`
  tracks the highest counter value seen per `(chapter,type)` and accumulates
  positive deltas (`util.applyReactionDelta`; first observation = baseline).
  `state.entered` = sum of all counters' `entered` (votes that actually landed);
  `~%` conversion = `entered / sent`. Server can silently drop votes while still
  returning `errno:0`, so HTTP success ≠ counted vote. Checkpoint persists
  `entered` + `perTarget` for `--resume`.
- `attemptWithRetries`: 429 → honor `Retry-After` header else exponential backoff
  (`500ms * 2`, cap `MAX_BACKOFF` 60s). Non-2xx or error → increment
  `consecutiveFails`; at `DEAD_THRESHOLD` (5) lane marked `dead`. HTTP 2xx but
  `errno != 0` / missing counter field counts as `invalid`, not a success.

### Server contract (important)

- POST to `apiPath` with body `{ "path": "<chapterId>", "type": "<reactionN>" }`
  (`type` from `--vote-types`, default `reaction0`).
- Success requires response JSON `{"errno":0,"errmsg":"","data":[{<reactionN>:<number>}]}`.
  Vote is "valid" only if `errno === 0` **and** `data[0][type]` is a number
  (`vote.parseVoteResponse(text, type)`). The field key matches the requested
  `type`. Each `reactionN` is an independent running counter; all of
  `reaction0/1/2/...` were confirmed to exist and increment separately.

## Conventions & gotchas

- **No `npm install` is expected** — the only third-party dep is `cmd-table`
  (already present in `node_modules`). `package.json` `test` script is a stub
  (`exit 1`). Don't add a build/test framework unless asked.
- **`runtime.js` is the single source of mutable state.** Keep it that way.
- Config is parsed at require time, so changing CLI parsing or `dns` behavior
  has global effects the moment `cli` is loaded.
- Any SOCKS5/HTTP proxy port works; proxy parallelism comes from OS processes
  on the host, not worker threads. The orchestrator never blocks the event loop
  (checkpoint + dashboard are async).
- Graceful shutdown: SIGINT/SIGTERM set `rt.stopping`; workers finish their
  current request, flush checkpoint, then exit 130.
