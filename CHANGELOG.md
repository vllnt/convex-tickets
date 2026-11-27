# Changelog

## [Unreleased]

First version, `0.1.0`. Canary only: it is meant for the `canary` tag, not
`latest`, and is not published yet. The stable `0.1.0` waits until a second,
different backend runs the core unchanged on a different layer (see
`docs/ROADMAP.md`). Nothing here is published as a stable release yet.

### Added

- **Core.** Work items ("tickets") with a queue, a named state mapped to one of
  six fixed categories (`backlog`, `unstarted`, `started`, `waiting`, `done`,
  `canceled`), a requester, an optional holder, typed flat fields and a typed
  result. Seven sandboxed tables: `queues`, `tickets`, `leases`, `messages`,
  `links`, `transitions` and `config`.
- **Queues.** `defineQueue` and `Tickets.sync`: states, fields, result fields
  and policy per queue. `sync` is additive: a state keeps its category, a used
  state cannot be dropped, a field cannot be removed or retyped. A queue with no
  states gets five (`open`, `working`, `waiting`, `resolved`, `canceled`).
- **Moves.** `open`, `claim` (a named ticket, or the next claimable one in a
  queue), `renew`, `release`, `assign`, `move`, `requestInput`, `reply`, `hold`,
  `resume`, `handoff`, `resolve`, `reopen`, `close`, `cancel`, `escalate`,
  `link` and `unlink`. Reads: `get`, `list`, `search`, `listMessages`,
  `listTransitions`, `listByRef` and `getQueue`.
- **Claims, leases and the fence.** `claim` is one transaction, so of two racing
  callers exactly one wins. `claimSeq` rises on each change of holder and every
  holder write carries it; a stale one gets `CLAIM_LOST`. The lease is a queue
  policy (`leaseMs`, five minutes by default, `null` for none).
- **Blockers.** `blocks` links plus an `openBlockers` counter. "Claim next"
  skips blocked tickets. Only a `completed` resolution clears a blocker; any
  other ending emits `blocker_failed`. Caps and a cycle check bound the graph.
- **Thread.** A flat, append-only message list with `public` and `internal`
  visibility. A requester reply to an input request supplies typed fields and
  returns the ticket to work.
- **Guardrails.** Hop limit, ping-pong check, message cap, per-requester open
  cap, per-party rate limits (through `@convex-dev/rate-limiter`), blocker caps,
  idempotency keys on `open` and `reply`. Expected refusals are results; every
  other failure is a coded `ConvexError` (`ERROR_CODES`, 32 codes). A refusal
  that does not escalate is recorded as a `guardrail_tripped` transition. The
  graph limits (`maxBlockers`, `maxBlocked`, `maxGraphWalk`) have ceilings
  (`LIMIT_CEILINGS`).
- **Escalation.** `escalateTo` per queue, used by the hop limit, the ping-pong
  check, the message cap, repeated lease expiry and an optional due-time
  escalation. Every automatic escalation (a refused handoff, a reached message
  cap, repeated lease expiry, the due time) happens once per ticket (an
  `escalatedAt` guard); the `escalate` call still works.
- **Timers and retention.** Lease expiry, due time and seal timers, each one
  scheduled function that does nothing when its value no longer matches. A daily
  purge cron deletes sealed tickets older than `retentionMs` (off by default).
- **Host hook.** `onEvent`, stored as a function handle and scheduled after
  every transition with a `ticketEvent` payload: one event per transition, with
  a `seq`. Delivery order is not guaranteed; the host orders by `seq`.
- **Typed client.** `Tickets<Q>`, `defineQueue`, `isIn`, and result unions
  (`ClaimResult`, `ReplyResult`, `HandoffResult`, `MoveResult`). Field and state
  names are checked at compile time and again against the stored queue
  definition at runtime.
- **Presets** (`@vllnt/convex-tickets/presets`): `agentQueue`, `deskQueue` and
  `projectQueue`.
- **Agent tools** (`@vllnt/convex-tickets/tools`): `ticketTools` returns eight
  tools (`open`, `list`, `get`, `claim`, `reply`, `requestInput`, `handoff`,
  `resolve`) with the acting party bound by the host.
- **Test helper** (`@vllnt/convex-tickets/test`): `register` mounts the
  component and its rate-limiter child in `convex-test`.
- **Example app.** The refund flow with an agent queue and a human queue, a desk
  queue, a project queue and a second mount, with a scripted agent woken by the
  hook. Covered end to end under `convex-test`.
- **Docs.** `README.md`, `docs/API.md`, `llms.txt`, `docs/ROADMAP.md` and the
  design spec in `specs/active/`. The npm package ships `README.md`,
  `docs/API.md`, `CHANGELOG.md` and `llms.txt`. `pnpm test:package` fails when
  one is missing or when `llms.txt` links a shipped file by URL.

### Known gaps

- No move edits fields after `open`, except `reply` and `handoff`.
- The example uses a scripted agent, not a live LLM on `@convex-dev/agent`, with
  no `@convex-dev/workpool`. The tools are not served over `@convex-dev/mcp`.
- Desk and projects are queues in the one example app plus tests, not separate
  example apps.
- There is no React entry.
- Hook events can arrive out of `seq` order on a real backend.
- All default numbers are starting guesses.
