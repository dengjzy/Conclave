# Autonomy

This is the current scheme. It replaces the per-phase P0–P14 notes.

## The pieces

- **Task**: one unit of work with a status, repos, an optional contract and a conversation.
- **Contract**: what "done" means. Checks, criteria, human items, unknowns, a baseline of failures
  that predate the task, and an autonomy level.
- **Flow**: one autonomous run of a task. It owns the implement turn, verification, retries,
  agent switches, replans, a wall clock and a report.
- **Run from a conversation**: a flow can start from an existing chat. It reuses that chat as its
  implement turn and attaches a task record for the contract and checks; it does not open a second
  conversation.
- **Command check**: the only verification primitive core knows. A check is a command, a repo, an
  optional cwd/env, a timeout and whether it is required.
- **Idea**: a title, notes, tags and an optional project, kept before it has an agent or a run. Its
  status doubles as the user's own to-do list (`idea`, `todo`, `doing`, `done`, `archived`).
- **Environment provider**: anything outside core that supplies a device/browser/service. It is a
  project script or an MCP server; core does not bundle ADB, iOS or a browser driver. A child
  verifier inherits the implement conversation's user MCP selection, never every server.

## Ideas

The sidebar's **Ideas** page is the capture surface. A record needs only a title; notes, tags and a
project are optional. From there the user can ask an agent to look at it (a new conversation with
the idea as its first message), start a task with it, or move it to `todo`/`done`/`archived`.

This is deliberately not a task: an idea has no worktree, contract or run until the user starts one.

## Starting work

A task can be created from the task board, or from the new-conversation draft with **自主任务**. A
new task defaults to an automatically chosen agent and, when the `flows` feature is present, starts
its flow on create. A conversation has a **运行** button that calls `flows.startConversation`. The run's state, attempts,
 hidden tests, red-first result and note stay in a bar under the conversation header, with stop and
 resume where they apply.

The first version of the conversation run keeps the conversation's existing workspace. It does not
move the chat into a new worktree; a chat that needs isolation should start in a worktree.

## What a flow does

```
plan → implement-1 → verify-1 → implement-2 → verify-2 → ...
```

A read-only planner splits the task into up to five steps. Each step gets its own implement and
verify node; a step's instruction is sent into the same conversation, so the agent keeps its context.
If the planner gives no usable plan, the flow falls back to one implement + one verify node.

The planner also sees which agents this run may start and can give a step to another one. Before
that step runs, core hands the task's conversation to that agent, so a plan can split the work by
strength ("api to codex, ui to claude") instead of sending everything to the first agent. A step
naming an agent this machine cannot write with falls back to the task's own agent.

- Before/while the implement turn runs, a read-only Test Author writes hidden tests from the task.
- Red-first runs those tests on the start commit. `not-red` pauses because the tests cannot prove
  the change; `blocked` continues with a note.
- Verify runs the contract's checks, or the project's `.conclave/project.json` check when the
  contract names none, plus the hidden tests.
- A failure is classified (`compile`, `test`, `environment`, `unknown`). The flow retries with the
  attempt history, switches agents after repeated failures, and asks a planner for a new approach
  after the second failure (at most two replans).
- It pauses on no progress, an environment failure, exhausted attempts, a failed/interrupted
  implement turn, a missing check, or the wall clock.
- Every terminal state writes a report with the nodes, attempts, hidden tests, red-first result and
  latest replan.

Checks in one repo run in order; different repos may run together. `required: false` failures are
reported but do not block a hand-in.

Saving a contract records a sha256 of its commands and the scripts they run. Verification recomputes
it in the worktree and blocks a changed script or `package.json` instead of reporting a pass the
implementer arranged. Artifacts a check names (`test -f RESULT.md`) are not treated as scripts.

## Verification and environment

Core records a check's exit code, output tail, duration and a stable signature. A baseline filters
failures that predate the task.

Device, browser and service work belongs outside core:

- a project script (`./scripts/verify-device.sh`) exits non-zero on failure; or
- an MCP server selected for the verifier/Test Author agent returns structured evidence, and a
  command validates it.

Core never knows the protocol behind either one.

## Safety

- No automatic merge, push or deploy.
- Worktrees are not deleted automatically; a task's worktree stays after the run.
- A flow does not submit when there is no executable check; it pauses for a person.
- The conversation run uses the existing chat; the task record is the audit envelope.

## Known limits

- The planner is a single read-only agent; its steps share one conversation, which changes hands
  rather than running in parallel. There is no parallel writing yet.
- The task board still holds committed work and runs; standalone to-dos live on the Ideas page,
  while a conversation's agent to-dos stay in that conversation's inspector.
- A conversation started in a project root runs its flow there; it is not moved into a worktree.
