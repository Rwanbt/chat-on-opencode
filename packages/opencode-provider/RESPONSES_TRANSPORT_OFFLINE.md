# Responses HTTP transport: isolated offline qualification

This is a **dependent Draft increment on PR #18**, rebased on its exact
`4a7d21d4651ff899eb26063f4d31865168d39048`. The merge of PR #17 is
`main` SHA `b3d6cdc70591eb5e0ff3140cebbd43a95a5ae4aa`. Rebase this stacked
work **only after** PR #18 is merged and its required checks have passed.

`src/responses-transport.mjs` adds `sendResponses(request, options)` on top of
the strict PR #18 request/SSE adapter. Required options: OpenCode-proven
`sessionID`, `messageID`, exact account-authorized `model`, and injected
`getToken({sessionID,messageID,model,signal})` returning `{ token, model }`.
The token supplier is an external trust boundary. Matching its model string
is **not** a proof of OAuth entitlement; no such supplier is installed here.
`fetchImpl` defaults to built-in fetch, but can be injected for tests.

It sends a bounded JSON `POST https://api.openai.com/v1/responses`, `store:false`,
`stream:true` with Bearer only in the HTTP header; disallows redirects,
cookies, HTTP non-200, non-SSE, error bodies, credential-bearing exceptions,
and other remote origins. An explicit `allowLoopbackTest:true` permits only
`http://127.0.0.1:<port>/v1/responses` for offline tests. No other loopback
hostname, DNS, URL query or arbitrary path is permitted.

The transport rejects duplicate active OpenCode session/message identities,
checks the terminal response's exact model, applies abort/timeout, validates
all SSE with strict UTF-8 and emits the **full result only after verified
`response.completed`**. It returns session/message/model provenance with the
result. Partial deltas, failed/incomplete/truncated responses, mismatched
model, unauthorized function calls and any tool history are rejected. It does
**not** provide token-by-token UI streaming or execute/authorize native tools.

This module is intentionally **not imported by `plugin/index.ts`** and does not
alter its CoS default, official OpenCode install, Goal, Loop, or Daemon. A real
OpenCode Responses pathway needs a separate account-authorized token supplier,
model entitlement, native permissions and gateway opt-in with isolated E2E.
No real account, cookie, personal profile, browser scraping, login or inference
was accessed or proven. Do **not** label this work production-ready.

Offline checks: `npm test` under `packages/opencode-provider`. The HTTP tests
use a real `127.0.0.1` server and synthetic bearer, split SSE frames,
cross-model rejection, abort during an unverified answer, error containment,
and refusal to dispatch tools or reach arbitrary endpoints. Real official
OpenCode 2.1.4 CLI Responses integration is **not demonstrated**, since the
plugin lacks the deliberately separate opt-in/authorized token boundary.
