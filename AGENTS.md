# Conclave

Task-first multi-agent manager. See docs/ARCHITECTURE.md for the architecture diagram and implementation details.

## Process boundaries

- **daemon** owns every agent process and PTY. **core** owns tasks, git and persistence, and serves the built Web client over HTTP. **web** is a browser client only, and so is core's MCP server (`mcp-main.ts`), a process of its own that agents start.
- **web** uses React, Vite, xterm.js and CodeMirror. It calls core over WebSocket; task logic, git and PTY ownership stay out of the client. Closing a browser tab must not stop an agent.
- Native modules (node-pty) load only in the daemon, which runs on plain Node. core and web must stay free of Electron imports.
- The browser-host protocol and core client remain for compatibility. This repository does not provide a browser host; running the Web client does not create embedded browser tabs. Keep this boundary explicit when documenting or changing browser features.

## Protocol

- `packages/protocol` is the single source of truth. Define a new RPC method or notification there as a zod schema, then implement it in `core/src/rpc-handlers.ts`.
- Clients and core can be on different versions. Adding an optional field is safe. A breaking change bumps `PROTOCOL_VERSION`, or `DAEMON_PROTOCOL_VERSION` for the daemon wire.
- Index `rpcSchemas` / `daemonSchemas` with a generic method name. Indexing the raw `rpcMethods` widens to a union of every schema.
- Status rules live in `checkMove` / `checkStart` / `manualMoves`. The UI calls them; it never re-encodes the rules.
- What an agent is and can do lives in its descriptor (`protocol/src/agents`) and adapter (`core/src/agents`); code elsewhere asks those, never `agent === '<id>'`. See docs/ARCHITECTURE.md, 新增 Agent.

## Safety

- core's listening address is configurable (`--host` / `CONCLAVE_HOST`): `pnpm start` defaults to `127.0.0.1`; direct core startup defaults to `0.0.0.0`. WebSocket RPC requires the token from `core.json`: any web page can open a localhost WebSocket. Keep local test instances bound to `127.0.0.1` unless network access is needed.
- Agent commands are argv arrays with `--` before the prompt. Never go through a shell.
- Only a refused connection proves a daemon socket is stale. A timeout or EPERM proves nothing.
- Worktrees are never deleted automatically: they may hold the only copy of an agent's work. A worktree goes only when the user cleans it, or when it provably holds nothing: a planning checkout once its task runs. Either way it is removed without force, and never one with changes or a commit no ref contains.

## Style

- Keep comments brief and non-obvious (why, not how).
- Avoid type assertions except `as const`.
- Name files after the concept they hold, never `utils` or `helpers`.
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Cross-platform: keep platform checks explicit (named pipes on Windows, `spawn-helper` on macOS).
- Visual decisions (colour, type, spacing, radius, the chat's row rhythm) follow `DESIGN.md`; read tokens from `styles.css`'s `:root`, never hard-code a colour.

## Verify

`pnpm typecheck && pnpm test`, plus `pnpm build` for Web or build pipeline changes.

To try the app by hand, run it against the test home instead of the user's real data: `CONCLAVE_HOME=~/.conclave-demo pnpm dev` (see docs/ARCHITECTURE.md, 从源码运行).

## Release

Source builds and application versioning follow [docs/RELEASING.md](docs/RELEASING.md). There is no automated application release or separate changelog. Change versions or publish only when the user asks.

Keep application, SDK/runtime and protocol versions distinct. Determine breaking changes from the changes themselves and commit `BREAKING CHANGE` footers.

## Commits

A trimmed version of Angular's [commit message format](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md).

```
<type>(<scope>): <summary>

<body>

<footer>
```

- **type**: `feat` (new feature), `fix` (bug fix), `refactor` (neither), `perf`, `test`, `docs`, `build` (build, dependencies, scripts), or `chore` (repo housekeeping that fits nothing else, like `.gitignore`).
- **scope**: the package: `protocol`, `core`, `daemon`, `web`, `dsh-runtime` or `plugin-sdk`. Leave it out when the change spans packages.
- **summary**: imperative, present tense, lowercase first letter, no trailing period, under 72 characters.
- **body**: why the change is needed, and how behavior differs from before. Required except for `docs` and `chore`.
- **footer**: `BREAKING CHANGE: <summary>` plus migration steps for anything that bumps `PROTOCOL_VERSION` or `DAEMON_PROTOCOL_VERSION`. `Fixes #<issue>` when there is one.
- One self-contained change per commit, with its tests.

```
fix(core): tell clients of a chat reopened after a restart

A client that lists conversations before reconcile has opened their
chats holds them with a session but no chat, so the composer reads as
busy and sends nothing.
```
