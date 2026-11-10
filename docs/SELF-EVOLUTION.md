# Self-evolution

Conclave fixing Conclave. One **generation** is one friction item taken through a shadow worktree
and a set of gates. The loop is a task like any other: a contract says what "done" means, a flow
runs it, and the trace is the evidence.

```
friction (a repro) → task + shadow worktree → flow (implement) → gates → self/evolve → person → main
```

## Branches

- **`self/evolve`** — every generation that passes the gates is fast-forwarded here. It is the
  staging line, and the only branch the loop may move.
- **`main` / `feat/autonomy-main`** — a person promotes `self/evolve` when the generations read
  well. The loop never pushes, and never touches `main`.

A generation starts from `self/evolve` and must stay a fast-forward: rebase onto the current tip
before the gates run, or the result is thrown away.

## Gates

A generation's contract checks are exactly these, in this order:

```
pnpm typecheck
pnpm test
pnpm build
pnpm self:smoke                        # isolated core boots, protocol, ideas, contract
pnpm self:tests --base <generation base>   # tests may change, but not shrink or gain skips
```

`self:smoke` starts its own core with a temp `CONCLAVE_HOME` and port, no daemon and no agent, then
checks `system.hello`, the feature list, ideas CRUD and a contract round-trip. It is the gate that
catches "compiles, tests pass, cannot start".

`self:tests` compares the test suite between the base and the candidate. Editing a test is allowed
when the change needs it — a generation that renames a concept legitimately renames its test. What
fails the gate is a suite that gets smaller: a deleted test file, fewer tests, or more `.skip`/`.
todo`. A person reads edited tests before promotion.

## Merge and rollback

1. Record the pre-merge tip (`refs/conclave/self/pre-<id>`).
2. Fast-forward `self/evolve` to the generation branch, only when the worktree is clean and the
   branch is based on the current `self/evolve`.
3. Probe the running core (`/conclave`, `system.hello`, features). If it does not serve within the
   deadline, move `self/evolve` back to the pre-merge tip and mark the generation failed.
4. Keep the generation branch. Worktrees are never deleted automatically; a clean one is marked
   cleanable.

The host should run under `pnpm dev:core:supervised` (`scripts/supervise-core.mjs`), which restarts
a core that dies or stops serving.

## Friction

A friction item is only valid with a repro: a command, a stack, or a sequence a person can repeat.
Without one it is a wish, and the loop cannot tell whether it fixed it.

```json
{
  "id": "watch-stuck",
  "summary": "tsx watch stops restarting after a branch rewrite; the host keeps serving old code",
  "repro": "rewrite a source file with git, touch it, watch core.json's pid stay the same",
  "expect": "the core restarts and system.hello reflects the new code",
  "paths": ["scripts/", "packages/core/src/main.ts"],
  "status": "open"
}
```

First batch: the stuck dev watcher, and a rebuilt web bundle that an open page keeps running.

## Status

Built: `self:smoke`, `self:tests`, the staging branch. Next: friction storage and the generation
runner (create the task, run the gates, merge to `self/evolve`, probe, roll back).
