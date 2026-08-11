---
name: handoff
description: Hand your work over to a fresh pirouette agent in the same worktree when your context has grown long, muddled, or expensive, and archive yourself. Use when the task is far from done but this conversation has outlived its usefulness — repeated compactions, a long debugging detour, or the user asking you to hand off / start fresh.
---

# Handing off to a fresh agent

A handoff replaces *you* with a new agent that has an empty context and the
same worktree. The successor inherits your project, working directory,
branch, uncommitted changes, model and thinking level. It inherits **none**
of this conversation — only the briefing you write.

You are handed off *from*, so you are the one who has to make the handoff
lossless. Everything the successor needs must be in the worktree or in the
briefing.

## When to do this

- Compaction has fired more than once and you can feel the earlier detail
  going soft.
- The conversation is dominated by a long dead end (a debugging spiral, a
  failed approach, a giant log dump) that the remaining work doesn't need.
- The user says "hand off", "start fresh", "new agent", or similar.

Prefer a handoff over `/compact` when the *useful* state is small and lives
in files anyway. Prefer compaction when the conversation itself is the state
(a design discussion, a review thread).

Don't hand off in the middle of an unstable worktree. The successor sees
whatever you leave behind.

Don't hand off when the *work* is finished and there is nothing for a
successor to do — a handoff would leave an idle agent sitting in the chat
list. Archive yourself instead:

```bash
pru archive --stop    # hides this chat and stops you; nothing is deleted
```

## Before you hand off

1. **Make the worktree tell the story.** Commit what's finished, push it,
   and update the PR description if there is one. Leave work-in-progress
   uncommitted only if you say so explicitly in the briefing.
2. **Leave nothing important only in your head.** Test commands, the failing
   case you were chasing, the branch's relationship to main, the decision
   you and the user made three hours ago — that is all about to be deleted.
3. **Check for running background work** (dev servers, long jobs) and either
   finish it or describe it.

## Write the briefing

Write it to a file — briefings are long, and shell-quoting a multi-paragraph
message is a good way to mangle it.

```bash
cat > /tmp/handoff.md <<'EOF'
You are taking over this task from a previous agent whose context got too
long. You are in the same worktree, on the same branch, with the same
uncommitted state.

## Task
<what the user actually asked for, in their terms>

## Where things stand
<what is done, what is in flight, what is pushed, PR number and CI state>

## What to do next
<the concrete next step, then the ones after it>

## Things you would otherwise have to rediscover
<test/build/repro commands, the gotcha that cost an hour, decisions already
made and why, paths worth reading first>

## Open questions for the user
<anything you were waiting on>
EOF
```

Write it for someone who knows the codebase but has never seen this task.
Do not write a transcript summary; write instructions.

## Hand off

```bash
pru handoff --message-file /tmp/handoff.md
```

With no agent argument this hands off *you* (the id comes from
`PI_SESSION_FILE`). Options:

- `--name <name>` — name the successor. Default is your name with the
  trailing number bumped: `fix-login` → `fix-login-2` → `fix-login-3`.
- `--message <text>` — inline briefing instead of a file.

What happens: the successor is created and starts working on the briefing
immediately, you are archived (the transcript stays on disk and stays
readable behind the dashboard's *show archived* toggle), and your session is
stopped a few seconds later.

## After the command returns

Say one line telling the user which agent took over, then stop. Do not start
new work — you are about to be stopped, and anything you do now happens in a
worktree that another agent is already using.

## Doing it without the CLI

The CLI is a thin wrapper over the server API, which is reachable from any
agent on the host:

```bash
curl -sS -X POST "$PIROUETTE_URL/api/agents/<your-id>/handoff" \
  -H 'content-type: application/json' \
  -d "$(jq -Rn --rawfile m /tmp/handoff.md '{message: $m}')"
```

Your id is the 8-hex suffix of your session directory:
`basename "$(dirname "$PI_SESSION_FILE")"`.
