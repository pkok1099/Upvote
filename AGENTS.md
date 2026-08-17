# AGENTS.md — Upvote (vote-load / rate-limiter test tool)

## What this repo is

A Node.js CLI that simulates mass voting against *your own* comic-web voting
server, to validate pre-launch behavior: per-IP rate-limiter accuracy, vote
overlap detection, and server throughput under load. It is **not** a library —
there is no public API surface; everything is driven through the CLI.

Code comments and docs are in Indonesian; identifiers/logic are standard JS.

## Environment constraints (read first)

- **Hardcoded Termux/Android paths.** `upctl.c` points `WIREPROXY` at
  `/data/data/com.termux/files/usr/bin/wireproxy` and links Termux `libcurl`.
  It only works in that Termux environment as-is. There is no
  config/env override for the binary paths.
- **`wireproxy` is an external binary**, not in this repo. `upctl` launches it
  per `.conf` file; the tool itself only speaks SOCKS5 / HTTP CONNECT
  to `127.0.0.1:<port>` exposed by those proxies.
- **Node >= 18** (uses native `fetch`). Repo runs on Node v26 here.
- The compiled `upctl` ELF (aarch64/Android) is **already built** and
  committed. Rebuild with `make` (uses `clang -O2 upctl.c -lcurl -o upctl`,
  needs `libcurl`). `upctl.c` is the C implementation of the proxy manager and
  the test harness — not something the JS depends on.

## Commands

```bash
# Main runner (the actual vote engine)
node upvote-core.js --id <uuid|chapter/<uuid>|url> --max <n> [opts]

# Proxy lifecycle (wireproxy/WG config folders)
./upctl {start|stop|restart|status|list} [wgcf-dir] [--fast|--skip]

# Convenience test harness (start proxies, wait handshake, run node, stop)
./upctl test [wgcf-dir] [votes] [delay-ms] [target-id]
```

`upctl` subcommands all take an **explicit config folder** (e.g.
`wgcf-30`, `wgcf-100`, `wgcf-p100`). The default dir name is `wgcf-multi`,
which **does not exist** in this repo — always pass the real folder. The
`test` subcommand defaults to `wgcf-p100`.

`upctl` flags: `--skip` (start proxies without any IPv6/health check,
fastest, no uniqueness guarantee), `--fast` (lighter checks, shorter timeouts,
skip duplicate-IP detection for already-running proxies). Order-independent.

## Core runner options (non-obvious ones)

From `modules/config.js:24` `parseArgs`. README omits `--api-url`, which
**does** exist:

| Flag | Meaning / gotcha |
|------|------------------|
| `--id`, `--url` | Plain UUID, `chapter/<uuid>`, or full URL → normalized to `chapter/<uuid>` (`util.extractChapterId`). Invalid input → process exit 1. |
| `--api-url` | Full vote API URL (not in README). Default `http://127.0.0.1:8000/api/article?lang=en`. **Tests use `https://commento.shngm.io/api/article?lang=en`** via an env default in the test scripts. |
| `--proxy-dir` | Folder of `wgcf-*.conf`; each conf's `BindAddress` port becomes a `socks5://127.0.0.1:<port>` proxy. |
| `--global-concurrency 0` | Default = **unlimited**, each proxy fully independent. Any N>0 installs a cross-proxy semaphore that *queues* excess requests (does not block event loop). |
| `--delay` | Per-proxy delay after a request; floor is 0. |
| `--jitter` | Added *random* 0..N ms per proxy so each proxy's rhythm is unique (mimics real users). |
| `--ipv6` | Forces IPv6 path. **Side effect:** monkeypatches `dns.lookup` to always family 6 and calls `dns.setDefaultResultOrder("ipv6first")` at require time. |
| `--resume` | Continues from `.upvote-checkpoint.json`; budget recomputed as `max(maxVotes - sent, 0)`. |

Exit codes (`runner.js:107`): `0` = target reached (checkpoint deleted),
`130` = stopped by SIGINT/SIGTERM (progress saved, `--resume` works),
`1` = target not reached.

## Architecture

Entry `upvote-core.js` wires modules via side effects on `require`:
1. `config` parsed (CLI args parsed **at require time** — `parseArgs(process.argv)` runs immediately, and `--help`/`--unknown` call `process.exit`).
2. `rt.budget = config.maxVotes`.
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
| `modules/config.js` | `CONFIG` defaults + CLI parsing (require-time). Exports resolved scalars (`target`, `maxVotes`, `delay`, `apiUrl`, `PARALLEL`, `IPV6`, …). |
| `modules/runtime.js` | The `rt` singleton: `state`, `LANES`, `budget`, dashboard vars, semaphore vars, `PROXIES`. |
| `modules/proxy-loader.js` | Runs on require; fills `rt.PROXIES` from `--proxy-dir` or `--proxy`/`HTTPS_PROXY`. |
| `modules/lanes.js` | `buildLanes()` — one `lane` per proxy, each with its own `ProxyAgent`. `lane.cap = ceil(maxVotes / proxyCount)`. |
| `modules/tunnel.js` | `ProxyAgent` (custom keep-alive http/https agent), SOCKS5 handshake, HTTP CONNECT tunnel, TLS wrap for HTTPS targets. |
| `modules/vote.js` | `sendVoteViaAgent` (http/https.request) + `sendVoteDirect` (fetch), and `parseVoteResponse`. |
| `modules/worker.js` | `independentWorker` loop; `claimBudget`/`releaseBudget` (anti-overshoot); `attemptWithRetries`. |
| `modules/semaphore.js` | Global concurrency limiter (`acquireSlot`/`releaseSlot`). |
| `modules/checkpoint.js` | Async checkpoint save (temp-file + atomic rename, coalesces rapid saves) and sync flush; load on resume. |
| `modules/dashboard.js` | Real-time stats line + paginated per-proxy table; in-place TTY repaint. |
| `modules/util.js` | `sleep`, `normalizeProxy`, `extractChapterId`. |

### Control / data flow

- `runner.spamVote()` → `buildLanes()` → `startStats()` → spawn one
  `independentWorker` per lane × `--concurrency`, `Promise.all` them.
- Each `independentWorker` loops: claim budget → `acquireSlot()` (if
  globalConcurrency>0) → `attemptWithRetries` → on success `state.sent++`,
  `saveCheckpointAsync()`; on fail `releaseBudget()` + `state.failed++` →
  sleep `delay + random(jitter)`. Loop breaks when: stopping, lane dead,
  `lane.sent >= lane.cap`, all lanes dead, or `state.started >= maxVotes*3`.
- `attemptWithRetries`: 429 → honor `Retry-After` header else exponential backoff
  (`500ms * 2`, cap `MAX_BACKOFF` 60s). Non-2xx or error → increment
  `consecutiveFails`; at `DEAD_THRESHOLD` (5) lane marked `dead`. HTTP 2xx but
  `errno != 0` / missing `reaction0` counts as `invalid`, not a success.

### Server contract (important)

- POST to `apiPath` with body `{ "path": "<chapterId>", "type": "reaction0" }`.
- Success requires response JSON `{"errno":0,"errmsg":"","data":[{"reaction0":<number>}]}`.
  Vote is "valid" only if `errno === 0` **and** `data[0].reaction0` is a number
  (`vote.parseVoteResponse`). `reaction0` is treated as the server's running
  vote total and surfaced in the summary.

## Conventions & gotchas

- **No `npm install` is expected** — the only third-party dep is `cmd-table`
  (already present in `node_modules`). `package.json` `test` script is a stub
  (`exit 1`). Don't add a build/test framework unless asked.
- **`runtime.js` is the single source of mutable state.** Keep it that way.
- Config is parsed at require time, so changing CLI parsing or `dns` behavior
  has global effects the moment `config` is loaded.
- Proxy config folders are named `wgcf-*` (`wgcf-30`, `wgcf-100`, `wgcf-p100`)
  but the tooling default is `wgcf-multi` — pass the real folder explicitly.
- `pthread`/async IO: the JS is single-process async; proxy parallelism comes
  from OS processes (`wireproxy`), not worker threads. The orchestrator never
  blocks the event loop (checkpoint + dashboard are async).
- `upctl` (C binary) is the **canonical** proxy manager + test harness; edit
  `upctl.c` and rebuild with `make`. The old shell scripts (`proxy.sh`,
  `test-30.sh`, `test-p30.sh`) have been removed — `upctl` supersedes them.
- Graceful shutdown: SIGINT/SIGTERM set `rt.stopping`; workers finish their
  current request, flush checkpoint, then exit 130.
