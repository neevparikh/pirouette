# Session persistence + resume spike

Status: complete

This spike proves that Pirouette can create a persistent pi SDK session, exit the process, and later resume the most recent session from disk with the prior conversation intact.

## What was built

- `src/spikes/session-resume.ts`
  - `new`: creates a fresh persistent session and sends an initial prompt
  - `resume`: re-opens the most recent session with `SessionManager.continueRecent(...)` and sends a follow-up prompt
  - `inspect`: lists saved sessions and prints the tail of the raw JSONL session file
  - `reset`: deletes the spike state
- session storage rooted at `.pirouette/spikes/session-resume/`
  - `workspace/` is the stable cwd for the spike
  - `sessions/` contains the JSONL session files

## Commands

```bash
npm run spike:session:new
npm run spike:session:resume
npm run spike:session:inspect
npm run spike:session:reset
```

## Result

The spike passed locally.

Observed flow:

1. `npm run spike:session:new`
   - created a new session file under `.pirouette/spikes/session-resume/sessions/`
   - sent a prompt telling the model to remember the token `pirouette-session-spike-token`
   - persisted the resulting user + assistant messages to disk
2. `npm run spike:session:resume`
   - loaded the same session file via `SessionManager.continueRecent(...)`
   - showed the earlier messages before sending any new prompt
   - asked for the remembered token
   - the model replied with exactly `pirouette-session-spike-token`
3. `npm run spike:session:inspect`
   - confirmed the JSONL session file contains the resumed conversation history

## Evidence

Example observed behavior:

- before resume prompt: 4 persisted entries, 2 messages in context
- after resume prompt: 6 persisted entries, 4 messages in context
- final assistant reply: `pirouette-session-spike-token`

The raw session file also showed both prompt/response pairs persisted in order.

## Notes / caveats

- This spike uses the default pi auth/model discovery from the local machine, so it depends on working pi credentials already being configured.
- `createAgentSession(...)` persisted non-message session state immediately as well (for example thinking level/model-related entries), so a newly created session can already have entries on disk before the first user prompt.
- The spike proves resume across process restarts. It does not yet prove resume across full container restarts, host restarts, or different filesystem mount layouts.
- The next follow-up for this spike, if needed, would be to run the same script inside the target Docker/container setup and verify the session path survives restart there too.
