# Native read result provenance — bounded offline parity increment

The CoS text bridge can request one OpenCode-native `read` call. OpenCode owns
local permission evaluation and execution; the provider must not execute a
file read. Previously, the gateway remembered only a generated call ID and
message ID. A later assistant/tool pair with that ID could substitute another
`function.arguments` path, and a successful read-result turn could be replayed.

The new `NativeReadCustody` records the exact generated function identity,
canonical arguments, session and originating message (volatile, max 1024,
30-minute monotonic expiry). Incoming read results must match all four,
contain exactly one paired native tool call and be text under the existing
64 KiB bound. The first accepted content is digest-pinned; an identical
retry after an unconfirmed CoS transport failure can use the existing
idempotent turn identity, but a different result is rejected. Successful
turn completion consumes the custody; a new user request abandons it.

`tool_choice: 'none'` is also now authoritative even when OpenCode advertises
the read tool schema: no native read instruction is sent to CoS and no tool
result is accepted in this mode. Failures return sanitized HTTP errors,
without file contents or secrets.

## Verified offline

- RED → GREEN HTTP regression: modified read path with correct call ID used
  to reach CoS; it now yields HTTP 403 before forwarding. Wrong session or
  message, completed-result replay, and missing/forged call also yield 403.
- Unit tests cover the equivalent reordered JSON arguments, stable retry
  digest, later altered tool content, abandonment, bounded map and expiry.
- `npm test` from `packages/opencode-provider` runs the package suite.
- Real official OpenCode 2.1.4 `opencode-v2-native-read.e2e.mjs`, with an
  isolated synthetic profile and compiled local mock service: allow and deny
  both PASS. ALLOW produces an actual native `read` tool event with file
  content; DENY produces no native `read` execution and leaks no marker.

## Honest limitations

Custody verifies what the local gateway *issued*, not an independent digital
attestation that the user clicked Allow. OpenCode's permission engine remains
the sole authority; the isolated E2E switches test permissions explicitly,
and does not exercise a real user's interactive approval dialog. The volatile
record intentionally disappears on gateway restart (old tool replies are
refused), and the bridge supports only one `read` tool, not full CoS tool
parity or arbitrary file/write/shell access. No user account, browser scraping,
credentials, installed Desktop profile or executable was accessed/modified.
This is offline protocol safety proof, **not** approved production inference.
