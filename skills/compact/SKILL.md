---
name: compact
description: Compact your own context in place with `pru compact` — summarise this conversation and keep working from the summary. Use when your context is getting long or expensive but the conversation itself is still the useful state (or the user asks you to compact), and you want to carry on in the same chat rather than hand off.
---

# Compacting yourself

Compaction replaces the conversation so far with a summary (pi keeps the most
recent messages verbatim). You stay the same agent, in the same chat, with the
same worktree; you just carry far less context into the next turn.

## When to do this

- Your context is long and much of it is spent: big log dumps, file reads you
  no longer need, a debugging detour that's resolved.
- You're about to start a new phase of the task and the earlier detail won't
  matter beyond a few facts.
- The user asks you to compact.

Prefer a **handoff** (the `handoff` skill) when compaction has already fired
several times and detail is going soft, or when the useful state lives in
files anyway. Prefer **compaction** when the conversation itself is the state
(a design discussion, a review thread, decisions made with the user).

## Before you compact

The summary is written by a model reading your transcript. Anything only
implied, or buried in a 2,000-line tool result, may not survive. So:

1. Say the important things plainly in a message first if they aren't
   already: current goal, what's done, what's next, commands that matter,
   decisions and why.
2. Commit / save work in progress so the worktree tells the story too.

## Compact

```bash
pru compact --instructions "Keep: the task, PR #123 state, the failing test and its repro command, decisions about X. Drop: the log dumps and the abandoned approach."
```

- With no agent argument it targets *you* (via `PI_SESSION_FILE`).
- It does **not** run immediately: it is queued until your current turn ends,
  because compacting now would abort this very command.
- `--instructions` / `--instructions-file` steer what the summary keeps.
- After the compaction you're woken with a "continue from where you left
  off" message as a new turn. Use `--message "<text>"` to replace it with
  your own next-step note, or `--no-continue` if you should stay idle
  afterwards (e.g. you're waiting on the user).

## After the command returns

End your turn right away with a one-line reply. Don't make more tool calls:
the compaction waits for the turn to end, and every extra step is more
context it has to summarise. When you're woken up, re-read the summary,
check the worktree state (`git status`, etc.), and continue.

## Doing it without the CLI

```bash
curl -sS -X POST "$PIROUETTE_URL/api/agents/<your-id>/compact" \
  -H 'content-type: application/json' \
  -d '{"afterTurn": true, "instructions": "...", "message": "Continue with ..."}'
```

Your id is the 8-hex suffix of your session directory:
`basename "$(dirname "$PI_SESSION_FILE")"`.
