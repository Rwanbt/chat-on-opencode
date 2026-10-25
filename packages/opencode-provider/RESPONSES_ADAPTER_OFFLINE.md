# Offline Responses adapter contract

`src/responses-adapter.mjs` is an **independent protocol proof**, not an installed provider.
It is neither imported by `plugin/index.ts` nor by the current CoS-based gateway.
No DevKit source, OAuth implementation, account credentials, HTTP client, browser activity,
live inference, tool execution or networking is included.

The caller gives `createResponsesRequest(chatCompletion, { model: authorizedSlug })`
an explicit model slug already chosen from the selected account's visible catalog.
The returned `body` is solely suitable for a **future** authorized
`POST https://api.openai.com/v1/responses` sender. It always includes `store:false`,
`stream:true`, full supplied text/history and a developer-scoped `additional_tools` item
for native function definitions, with no token or URL. It refuses every unknown
Chat Completions parameter, unsupported content type, hosted tool, unresolved model,
or unmatched tool-result identity. `allowedTools` is a capability list for **output
validation**, never authority to execute a local operation.

`collectResponsesSSE(asyncByteChunks, { signal, allowedTools })` accepts only bytes from
the future transport. It parses strict UTF-8, bounded CRLF/LF SSE, final text and
function-call identities. It returns only after `response.completed` with
`response.status="completed"` and a consistent complete `response.output`. It rejects
`response.failed`, `response.incomplete`, stream truncation, invalid JSON/UTF-8,
unauthorized tools, mismatched call arguments, contradictions between streamed and
terminal content, and cancellation. It buffers the answer until verified completion;
**no early user-visible token streaming** is currently exposed. It never executes
or approves tools. A future integration must return native tool calls to OpenCode,
which remains the sole owner of approval and execution.

The OpenCode plugin must additionally prove the authenticated account/model choice,
session/message provenance, native permissions, and that a tool result came from an
issued OpenCode call. The standalone adapter cannot establish those external facts.
The present implementation supports text and function tools only; images, files,
audio, video, response reasoning recovery, and unsupported stream events fail closed.
It deliberately makes no promise of full OpenCode model or tool parity.

Validate offline with `node --test test/responses-adapter.test.mjs` or `npm test` in
`packages/opencode-provider`. Tests never open sockets or fetch credentials.

Protocol sources (accessed 25 October 2026):

- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://developers.openai.com/api/docs/guides/tools-tool-search
