# Event streaming spike

Status: complete

This spike proves that Pirouette can subscribe to pi SDK session events on the backend, forward them over WebSocket, and consume them from a browser-compatible client.

## What was built

- `src/spikes/event-streaming.ts`
  - `serve`: starts a tiny HTTP + WebSocket server
  - `client`: connects as a WebSocket client, triggers a prompt, and validates the streamed event sequence
  - `reset`: removes local spike state
- a minimal HTML page served at `/`
  - opens a WebSocket to `/ws`
  - sends prompts via `POST /prompt`
  - logs streamed JSON event envelopes in the browser
- local spike state rooted at `.pirouette/spikes/event-streaming/`
  - `workspace/notes.txt` is read by the agent during the spike
  - `sessions/` stores the pi session file for the server-run agent

## Commands

```bash
npm run spike:stream:serve
npm run spike:stream:client
npm run spike:stream:reset
```

Then optionally open:

```text
http://127.0.0.1:7781
```

## Result

The spike passed locally.

Validated flow:

1. backend created a pi session and subscribed to `session.subscribe(...)`
2. backend normalized events and broadcast them to WebSocket clients
3. client connected over WebSocket and sent a prompt through the HTTP endpoint
4. agent used the `read` tool on `notes.txt`
5. client observed streamed events including:
   - `agent_start`
   - `turn_start` / `turn_end`
   - `message_start` / `message_end`
   - `message_update` with `toolcall_*` updates
   - `tool_execution_start` / `tool_execution_end`
   - final `message_update` text deltas for the assistant reply
   - `agent_end`
6. final streamed assistant text matched `STREAMING_SPIKE_OK`

## Evidence

Observed successful event sequence included both tool and text streaming, for example:

- `message_update` `toolcall_start`
- `message_update` `toolcall_end` with tool name `read`
- `tool_execution_start` for `read`
- `tool_execution_end` for `read`
- `message_update` `text_delta` with `STREAMING`
- `message_update` `text_delta` with `_SPIKE_OK`
- final assistant text: `STREAMING_SPIKE_OK`

## Notes / caveats

- The server currently normalizes events to a JSON-safe subset before broadcasting. That is probably the right shape for the real app too; broadcasting raw SDK objects is unnecessary and more brittle.
- The spike uses HTTP for prompt submission and WebSocket for event streaming. That split seems perfectly reasonable for the real app.
- The first attempt using the default restored model hit an Anthropic rate-limit path. The spike now explicitly uses `anthropic/claude-haiku-4-5` to keep the test lightweight and reliable.
- This proves browser-compatible transport and event fidelity for a single local process. It does not yet prove multi-client fanout, reconnect behavior, auth, or production reverse-proxy behavior.
