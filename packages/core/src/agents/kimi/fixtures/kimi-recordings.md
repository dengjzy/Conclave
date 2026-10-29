# Kimi Code recordings

Captured from the official `@moonshot-ai/kimi-code` npm release 2.3.2 on 2026-10-26,
with an isolated `KIMI_CODE_HOME` and a local OpenAI-compatible scripted provider.
No Kimi credentials or paid model calls were used.

- `kimi-session.jsonl`: initialize, session creation, Plan → Default, a streamed
  Bash call (`printf conclave-kimi-smoke`), its approval and result, and the final reply.
- `kimi-resume.jsonl`: initialize and load the recorded session, ignore the replayed
  history, then accept a second prompt and the real context usage update.

Request/session IDs and the working directory are normalized. Only the six built-in
commands are retained; locally discovered skill names and authentication paths are
removed. The load exchange was captured on the same process, then split with its
initialize exchange to exercise Conclave's normal resume after process restart.

Kimi reports context occupancy (`usage_update.used/size`), not per-turn billing token
buckets in these recordings. Tests must not treat context occupancy as turn usage.

The question and plan-review test frames follow the official mappers:

- [IDE integration](https://moonshotai.github.io/kimi-code/en/guides/ides.html)
- [ACP modes](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/modes.ts)
- [Question bridge](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/interaction-bridge.ts)
- [Approval mapper](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/approval.ts)
