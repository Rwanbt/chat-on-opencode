# Bounded sequential native reads (offline preview)

The experimental OpenCode V2 provider could previously issue **one** local
`read` tool request, then had to answer without reading another file. The
second native read was refused even when the user's question required comparing
two files. This change permits **at most two sequential native reads** during
one originating OpenCode message, never parallel or arbitrary tool loops.

After native OpenCode executes and returns the first `read`, the gateway checks
its issued-call custody: exact session, message, call identity, arguments and
result digest. Only then may the CoS text bridge ask for **one more** native
`read`. That call gets a distinct identity derived from the previous call ID,
is published as another OpenAI-compatible `tool_calls` response, and must
pass through OpenCode's own permission checks and native executor again.

On the second result, the gateway removes permission to request another read.
A third `<opencode-read>` envelope fails closed with HTTP 422 and **cannot
produce another native tool call**. A stale first result fails custody (403),
including after the second call is issued; an unanswered call is never treated
as a granted continuation. A later user message abandons unfinished custody.
The gateway itself executes **no local tools** and cannot grant read access.

## Tests

* RED→GREEN loopback HTTP: PR35 answered 422 when the second native read was
  requested; now 2 distinct tool calls succeed, first-call replay fails with
  403 and a third attempt is refused with 422.
* Unit tests cover the two-call limit, unanswered requests, cancellation by
  abandonment, distinct IDs and wrong-stage replays.
* Actual installed **official OpenCode 2.1.4** CLI: offline E2E on Windows
  creates two separate throwaway files and a compiled local CoS fixture.
  With synthetic native permission `allow`, the CLI reports **two completed
  native `read` tool events** with contents of the corresponding real files;
  final assistant marker `TWO_NATIVE_READS_OK` is observed. Existing one-read
  `allow` and `deny` tests continue to run independently.

## Important limits

The E2E grants read in an isolated synthetic profile; it **does not test two
interactive human approval clicks**. Production retains permission effect
`ask` and OpenCode—not the gateway or CoS—must authorize each tool execution.
The bridge is still text-only, only `read` is enabled, no shell/write/edit,
file discovery tools, parallel tool calls or full Chat On Steroids parity.
Neither the user's profile nor account, stored auth, running Desktop app or
official CLI binary is changed. No actual ChatGPT browser or inference is
used; this is an offline protocol and native-permission proof.
