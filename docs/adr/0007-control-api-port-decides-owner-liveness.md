# ADR-0007: The control API's port, not its pid, decides whether a CoS owner is alive

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge), ADR-0004 (evidence scope)

## Context

The provider starts the isolated CoS helper as a child process and talks to it through the CoS
control API. The helper publishes `control-api/endpoint.json` — protocol, port, pid, app version,
start time — and the provider uses that file to decide whether the profile is already owned by a
live helper, before it spawns a second one.

That decision was made from the **pid** alone: `process.kill(pid, 0)` succeeded, so the profile was
declared occupied. Two facts make the pid the wrong authority.

1. **The helper never gets to clean up on Windows.** The provider terminates it with
   `child.kill('SIGTERM')` (`src/runtime.mjs:181`). On Windows, Node maps that to
   `TerminateProcess`, so the helper cannot run its shutdown path and cannot remove its own
   endpoint file. The file therefore survives *every* provider shutdown on Windows.
2. **Windows reuses pid numbers.** The leftover file names a pid that is later given to an
   unrelated process. The pid is then alive, and it belongs to somebody else.

Measured on the isolated profile during the real-project coding qualification:

| Fact | Value |
| --- | --- |
| Endpoint written by the helper | `startedAt` 2026-10-29T12:56:31.926Z, pid 10620, port 60224 |
| Process holding pid 10620 later | `node.exe` (a Playwright MCP server), **created 17 minutes after** the endpoint was written |
| Recorded control-API port 60224 | not listening |

The provider therefore refused to start with `runtime_profile_endpoint_occupied` — forever. The
isolated profile had become unusable, and the cause was invisible: the gateway child stayed alive
on its parent IPC channel after the fatal error (`src/server.mjs` only set `process.exitCode`), so
the parent waited out its whole 90-second health timeout and reported
`provider_runtime_start_timeout` instead of the real cause.

## Decision

**A recorded endpoint is live only while its control API answers on its recorded port.**

This is exact, not heuristic. The CoS app listens on its control API first and publishes the
endpoint file only once the listener is up (`src/main/control-api.ts:164` then `:180`), and it
removes the file when the app quits (`:141`). So:

- a connection refused on the recorded port proves that no owner is serving that control API, and
  the file is stale;
- a connection accepted means an owner is there, and the profile must be refused;
- an unknown outcome or an unusable port means "possibly occupied", and the caller refuses.

The probe opens a TCP connection and sends **no payload**: it must never talk to a foreign
listener, and it never carries the control-API token.

**An owned gateway reports its cause and then terminates.** The cause is a fixed category token
sent over the IPC channel the process already owns (`src/owned-failure.mjs`), and the process then
exits. The parent surfaces that category instead of inventing a timeout.

## Consequences

- A leftover endpoint file can no longer brick an isolated profile. The refusal remains exactly as
  strict against a **live** owner: the pre-spawn check still refuses before any child is launched,
  and the post-spawn check still refuses to adopt an endpoint that is not the child's own.
- The pid check is gone from the occupancy decision. It was the only signal that could be fooled by
  an unrelated process; the port cannot be fooled that way, because the port is where the owner
  actually serves.
- A fatal startup failure is now fast and named. The parent learns
  `provider_runtime_exited:<category>` instead of waiting 90 seconds for a timeout that never
  explains itself.
- The probe costs one loopback connection per startup attempt. It is bounded and never blocks the
  event loop for longer than its timeout.

## Alternatives considered

- **Keep the pid check and treat a live pid as an owner.** Rejected: this is the defect. It
  refuses a free profile because an unrelated process inherited the number.
- **Delete the endpoint file when the pid is dead.** Rejected: it does not help, because the
  offending pid is *alive*. It would also let the provider destroy a live owner's discovery file.
- **Let the helper delete its own file on shutdown.** Useful but insufficient: the helper is
  terminated rather than asked to quit, and a crash or a reboot leaves the file behind anyway. The
  port proof covers every cause, including causes no cleanup can.
- **Ask the endpoint whether it is alive over HTTP.** Rejected: that is contacting a possibly
  foreign listener, and it would put the control-API token on the wire to a process that may not
  be ours.
- **Wait longer for the gateway.** Rejected: it hides the cause instead of reporting it.

## Evidence

- `src/endpoint-liveness.mjs` — `probeLoopbackPort`, `endpointHasLiveOwner`.
- `src/runtime.mjs` — the pre-spawn and post-spawn ownership checks now use the port proof.
- `src/owned-failure.mjs` — the fixed-category cause report and the termination.
- `src/server.mjs` — the fatal startup path reports and terminates.
- `src/lifecycle.mjs` — the parent surfaces the reported category.
- `src/main/control-api.ts:164`, `:180`, `:141` — the app-side invariant this decision relies on.
- `test/endpoint-liveness.test.mjs` — a stale endpoint whose pid is alive no longer blocks the
  profile, and a live control API still blocks it.
- `test/owned-failure.test.mjs` — the parent names the cause instead of reporting a timeout.

**Evidence level.** The measurement of the recycled pid is *authentic* (a live Windows run against
the isolated CoS profile). The regression tests are *synthetic* and reproduce the same states
deterministically.

## Revisit trigger

Revisit when the CoS app publishes its endpoint before its listener is up, when the helper can be
asked to quit instead of being terminated, or when the provider learns to own a durable lease on
the profile instead of inferring ownership from a published file.
