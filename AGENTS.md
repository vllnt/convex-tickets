# @vllnt/convex-tickets

Work items that humans and AI agents open, claim, discuss, hand off and resolve,
as a Convex component. One core, three thin layers: an agent board, a support
desk and project tracking.

A sandboxed Convex component following the vllnt Component Standard. 0.1.0 is a
canary release: published under the `canary` tag only.

## Agent instructions

`AGENTS.md` is the sole agent-instruction source for this repository. Do not add
`CLAUDE.md` or `.claude` content (`pnpm check:agents` fails if you do).

## Architecture

```
src/
├── shared.ts              # categories, transition types, ERROR_CODES, defaults, validators, the ticketEvent payload, ticketsError / isTicketsError
├── test.ts                # convex-test register() helper (mounts the component and its rate-limiter child)
├── client/
│   ├── index.ts           # Tickets<Q> client class, defineQueue, result unions (consumer-facing API)
│   ├── types.ts           # queue, field and state typing (FieldValues, StateName, QueueMap, ...)
│   ├── presets.ts         # agentQueue, deskQueue, projectQueue, DESK_STATES, PROJECT_STATES
│   └── tools.ts           # ticketTools: the eight agent tools bound to one party
└── component/
    ├── mutations.ts            # all public mutations (sync, open, claim, renew, release, assign, move, requestInput, reply, hold, resume, handoff, resolve, reopen, close, cancel, escalate, link, unlink)
    ├── queries.ts              # all public queries (get, list, search, listMessages, listTransitions, listByRef, getQueue)
    ├── internal_mutations.ts   # timers (expireLease, dueTimer, sealTimer) and the retention purge
    ├── crons.ts                # the daily purge cron (a no-op until retentionMs is set)
    ├── engine.ts               # the one place a ticket changes: transition(), leases, blockers, seal, escalate, hook scheduling
    ├── queues.ts               # queue lookup, landing states, field and length checks, the additive sync rules
    ├── views.ts                # row -> public view mappers (drop the idempotency key and internal counters)
    ├── validators.ts           # shared validators and the result unions
    ├── schema.ts               # sandboxed tables (queues, tickets, leases, messages, links, transitions, config)
    └── convex.config.ts        # defineComponent("tickets"); child: @convex-dev/rate-limiter
example/
└── convex/                # example app: refund flow (agent queue + human queue), desk and project queues, a scripted agent woken by the hook, a second mount
docs/
├── API.md                 # API reference (ships in the npm package)
└── ROADMAP.md             # what is next, and the stop rule
specs/active/              # the design this package is built from
```

## Ownership boundary

- **Component owns:** the `queues`, `tickets`, `leases`, `messages`, `links`,
  `transitions` and `config` sandboxed tables. Ticket state: category, named
  state, holder, `claimSeq`, lease, blockers, resolution and result, due time,
  seal. The thread, the history, the guardrails (hop limit, ping-pong check,
  message cap, per-requester open cap, rate limits), the timers, the retention
  purge and the scheduled hook call.
- **Host owns:** identity and auth. The host derives `actor` from its own auth
  layer and passes it in. The component trusts `actor.ref` and never branches on
  `actor.kind`. The host decides who may open in a queue, who may call `assign`,
  `close` or pass `trusted`, and who may read `view: "internal"`. The host also
  runs the work itself: the component never executes anything.
- **Auth:** the component checks only a caller's relation to a ticket (holder,
  requester, claim number). It never calls an auth library. A host that exposes
  holder moves for anyone must say so with `trusted`.

## Key design decisions

- **One core, three presets.** Agent board, support desk and project tracking
  are queue definitions (states, fields, policy), not code paths. Rules read the
  category, never the state name.
- **Six fixed categories.** `backlog`, `unstarted`, `started`, `waiting`,
  `done`, `canceled`. Queues name their own states and map each to one category.
  A state never changes category once synced.
- **A started ticket always has a holder.** Claim sets the holder. Release,
  lease expiry, escalation and a handoff to a queue clear it; a handoff to a
  party moves it to that party. Each raises `claimSeq`.
- **Claim, lease and fence.** `claim` is one transaction, so exactly one of two
  racing callers wins. `claimSeq` is the fence: every holder write carries it,
  and a stale one gets `CLAIM_LOST`. A lease is optional per queue (`leaseMs`),
  and a timer returns the ticket when it runs out.
- **Losing a race is a result, not an error.** `claim`, `reply` and `handoff`
  return a union for the expected refusals. Everything else throws a coded
  `ConvexError` (`ERROR_CODES`).
- **Blockers are links plus a counter.** `blocks` links and `openBlockers` on
  the ticket. Only a `completed` resolution clears a blocker. Caps and a cycle
  walk bound the graph.
- **A seal is a one-way latch.** `closedAt` ends all writes. A done or canceled
  ticket can be reopened until the reopen window ends.
- **The hook is a scheduled function handle.** One event per transition, with a
  `seq`. Delivery order is not guaranteed: the host orders by `seq`. A hook that
  throws cannot roll back the move.
- **History and the hook replace logs.** The component does not log. Every
  transition is a `transitions` row and a hook event.
- **Flat scalar fields.** Fields and results are records of string, number,
  boolean or null, checked against the stored queue definition at runtime. No
  `v.any()`.
- **Additive `sync`.** Queue definitions are written once per deploy and can
  only grow. Removing a field, changing a type or changing a state's category is
  refused.
- **Bounded everything.** Every list is paginated or capped. Retention is off
  until `retentionMs` is set.

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts` (enforced by
  `@vllnt/eslint-config/convex`). Timers and the purge live in
  `internal_mutations.ts`.
- Every move of a ticket goes through `transition()` in `engine.ts`. That is
  what patches the ticket, writes the history row, bumps `seq` and schedules the
  hook. Do not patch a ticket's state, holder or fields anywhere else. Only the
  counters (`openBlockers`, `messageCount`) are patched on their own.
- Explicit `args` and `returns` on every Convex function.
- No bare `v.any()`. Fields and results use `scalarRecordValidator`.
- Errors are `ticketsError(code, message)`. Add a new code to `ERROR_CODES` in
  `src/shared.ts`, then to the error table in `docs/API.md`.
- Result unions are validators in `src/component/validators.ts`; the client
  types derive from them.
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds).
- Runtime deps: only official `@convex-dev/*` and `@vllnt/*`. Used today:
  `@convex-dev/rate-limiter` (child component for open and message rate limits).
  Dev tooling: `@vllnt/eslint-config` (lint) and `@vllnt/typescript` (tsconfig
  base).
- Not used, on purpose: `@vllnt/logger` (the component does not log), a private
  Playwright end-to-end kit (not a fit for `convex-test`),
  `@vllnt/convex-helpers` (nothing it offers is needed), and
  `@convex-dev/workpool`, `@convex-dev/agent`, `@convex-dev/mcp` (the example is
  scripted; a host may add them). Do not add one without a current need.
- Default numbers (`DEFAULT_POLICY`, `DEFAULT_LIMITS`) are starting guesses.
  Document a change in `docs/API.md` and `CHANGELOG.md`.
- Never write local paths, private host names or private repo names in docs or
  code. `scripts/privacy-denylist.sh` enforces this in CI.

## Generated code

- Every `**/_generated/**` file is owned exclusively by Convex CLI codegen.
- Never create, edit, lint, or format generated files manually.
- Run `pnpm codegen` to regenerate them and commit the generated output
  unchanged.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
```

`pnpm test` also runs `pnpm test:package`, which checks what the npm tarball
ships. Use `pnpm build:codegen` only when regenerating checked-in Convex
`_generated` files and you have access to the selected Convex project.

## Docs sync (MANDATORY)

When any of these change, update the matching docs in the SAME commit (then
`pnpm generate:llms`):

| Change                                        | Update                                                     |
| --------------------------------------------- | ---------------------------------------------------------- |
| Mutation/query args or return types           | `docs/API.md`, README API table                            |
| Error code added, removed or re-purposed      | `docs/API.md` (Errors), README Guardrails                  |
| Hook payload or transition type               | `docs/API.md` (ticketEvent), README Host hook              |
| Schema table added/removed/modified           | this file (Architecture, Ownership), README                |
| Child component added/removed                 | README Dependencies, this file (Architecture, Conventions) |
| Default number or preset changed              | `docs/API.md` (Defaults, Presets), README                  |
| New feature / breaking change                 | `CHANGELOG.md`, README Features                            |
| Security model, `trusted` flag, internal view | README Security and trust, `docs/API.md` (Security model)  |
| Behaviour that differs from the design        | `specs/active/2026-11-27-convex-tickets.md` (Gaps)         |
| Scope moves in or out                         | `docs/ROADMAP.md`                                          |
| `peerDependencies.convex` range               | `llms.txt` context line, `docs/API.md` Compatibility line  |
