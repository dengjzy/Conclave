# Autonomy

This is the current scheme. It replaces the per-phase P0–P14 notes.

## The pieces

- **Task**: one unified unit of work on the board. Without a project it acts as a lightweight backlog
  item (`pending` with a `Needs project` badge); once linked to a repo it owns its isolated git
  worktree, specification (`details`), optional contract and conversation.
- **Contract**: what "done" means. Executable checks (with sha256 tamper protection), an optional
  metric ratchet (`direction: 'maximize' | 'minimize'`, optional `target`), human review checklist
  items, a baseline of failures that predate the task, and attempt/wall-clock budgets.
- **Flow**: the single autonomous execution engine for tasks. It owns the implement turn,
  verification, metric-ratchet checkpoints/rollbacks, environment supply (`waiting_environment`),
  retries, agent switches, replans, a wall clock and a report.
- **Run from a conversation**: a flow can start from an existing chat. It reuses that chat as its
  implement turn and attaches a task record for the contract and checks; it does not open a second
  conversation.
- **Command check**: the only verification primitive core knows. A check is a command, a repo, an
  optional cwd/env, a timeout and whether it is required.
- **Environment supply (`flows.supplyEnvironment`)**: when a check fails because a CLI, MCP server,
  service or environment variable is missing, the flow enters `waiting_environment` with a structured
  `demand` and presents an interactive supply card in `FlowPanel` (attach MCP servers, inject check
  env vars without changing the contract hash or leaking secret values into chat, and resume).

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
- A failure is classified (`compile`, `test`, `environment`, `unknown`). Missing environment/tooling
  moves the flow to `waiting_environment` until supplied; code/test failures retry with the attempt
  history, switch agents after repeated failures, and ask a planner for a new approach after the
  second failure (at most two replans).
- When `contract.verification.ratchet` is configured and passing checks emit `METRIC_SCORE=<number>`,
  the flow commits a git checkpoint in the task's isolated worktree whenever the score improves,
  rolls the worktree back to `bestCommit` when a later attempt regresses, and hands the task in for
  review once `target` (or `GOAL_REACHED=true`) is reached or the attempt budget finishes with at
  least one verified checkpoint.
- It pauses on no progress, exhausted attempts without a ratchet checkpoint, a failed/interrupted
  implement turn, a missing check, or the wall clock.
- Every terminal state writes a report with the nodes, attempts, best metric score (when applicable),
  hidden tests, red-first result and latest replan.

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
- A conversation started in a project root runs its flow there; it is not moved into a worktree.
