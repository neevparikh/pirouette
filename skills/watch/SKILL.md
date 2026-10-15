---
name: watch
description: Have the pirouette server wake you with a message when something you're waiting on happens, instead of sleeping or polling in a tool call. Use after pushing a PR (CI results, reviews, merge), when starting a long build, test run, or job, when waiting for a condition (a file, a deploy, a run finishing), or when you need to check back later.
---

# Waiting with `pru watch`

A tool call that sleeps or polls ties you up, hits the bash timeout, and
dies if the server restarts. A **watch** hands the waiting to the server:
you set it, end your turn, and the server sends you a message when it
fires. The message starts a new turn, or is queued behind your current
one.

```bash
pru watch pr 123                         # PR checks, reviews, merge, conflicts
pru watch cmd 'npm run e2e'              # run in the background, wake on exit
pru watch until 'curl -sf https://staging.example.com/health' --every 30s
pru watch timer 2h --note "check whether the backfill caught up"
pru watch ls                             # your pending watches
pru watch rm w12                         # cancel one
```

Every kind takes `--note "<text>"`. The note comes back in the wake-up
message, so write down what you meant to do next ("if green, mark #123
ready for review"). By the time the watch fires your context may have been
compacted.

## The kinds

- **`pr <number|url>`** (`-R owner/repo` outside the repo). Fires on the
  first of these: a check fails (the others may still be running); all
  checks pass; a new review or comment arrives; the PR is merged or
  closed; it gets a merge conflict. If the checks have already finished
  when you set it, it fires right away. `--on checks,reviews,merged,conflict`
  narrows it. Inline review comments aren't in the message, only the
  review that contains them, so read them with `gh` when one arrives.
- **`cmd '<command>'`** runs the command in the background, in the
  current directory, and fires when it exits. The message has the exit
  code, the last 40 lines of output, and the path to the full log.
  `--timeout 1h` kills it if it runs too long. A server restart kills it
  too, and you're told when that happens.
- **`until '<command>'`** re-runs the command every `--every` (default
  60s) and fires the first time it exits 0, with its output. Make it
  cheap and side-effect free; it may run hundreds of times.
- **`timer <duration>`**: `30m`, `2h`, `1d`.

`pr` and `until` give up after 24h by default (`--timeout` to change it,
30 days max) and wake you to say so. Every watch fires once. Set a new one
if you need to keep waiting, e.g. after pushing a fix for a failed check.

Quote the command as one argument. Unquoted words that start with `-`
are read as `pru` options.

## Who gets woken

From inside an agent, the watch wakes you. `--agent <id>` wakes someone
else, e.g. a crew agent setting a watch that should wake its captain.
`--steer` delivers the message after the agent's current step instead of
after its whole turn.

## Habits

- After `gh pr create` or a push that should go green, run `pru watch pr
  <n>` and end your turn with a short status, rather than
  `gh pr checks --watch`.
- When it fires on a failure, read the failing log
  (`gh run view <run-id> --log-failed`), fix, push, and set a new watch.
- Don't stack duplicate watches on the same thing. Check `pru watch ls`
  first.
- Watches survive a handoff: they move to your successor.
