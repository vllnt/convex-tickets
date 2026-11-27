---
title: "@vllnt/convex-tickets: Convex component for work items"
status: active
created: 2026-11-27
tier: standard
---

# @vllnt/convex-tickets: Convex component for work items

**Gate note (2026-11-27).**

- **Rule of Three.** No second consumer is named. The override is recorded per
  decision 4. Build for the first adopter (the owner's own agent fleet, board
  layer). Publish canary only. Hold the stable 0.1.0 until a second, different
  backend runs the core unchanged on a different layer (desk or projects).
- **Stop rule.** If no second backend does within one quarter (by 2027-02-27),
  move the code into the first adopter and archive the repository.
- **npm scan, re-run 2026-11-27.** All 404: `@zendesk/convex`,
  `@intercom/convex`, `@linear/convex`, `@vercel/convex`, `@team-plain/convex`,
  `@frontapp/convex`, `@pylon/convex`, `@chatwoot/convex`,
  `@convex-dev/tickets`, `@convex-dev/helpdesk`, `@convex-dev/tasks`,
  `@convex-dev/issues`, `@convex-dev/projects`, `@convex-dev/board`,
  `@convex-dev/kanban`, `@convex-dev/inbox`, `@convex-dev/a2a`, and
  `@vllnt/convex-tickets` itself (the name is free).
- **Directory re-check, 2026-11-27.** The Convex components directory (its
  machine-readable index) lists 201 components, 30 official. A keyword scan for
  tickets, helpdesk, kanban, issue and task tracking, inbox, work queue and
  handoff found no ticket, task tracker, issue tracker or agent inbox. The
  nearest hits are job queues (`@convex-dev/workpool`, a batch worker, an email
  queue) and a browser-automation component's task tracking. None of them is a
  work item.

## Summary

A ticket (a "work item") is a unit of work passed between parties. A party is an
opaque reference with a kind hint: `human`, `agent` or `system`. The component
stores who holds the work, what state it is in, what it waits on, what was said
and what came out. It never runs the work.

- One core and three thin layers: an **agent board**, a **support desk** and
  **project tracking**. A layer is queue settings plus host code. It cannot read
  the core's tables, because a component's tables are sandboxed.
- Seven small tables, six status categories and eight agent tools.
- The package is a vllnt Component Standard component. 0.1.0 is a canary
  release.
- No official `@convex-dev/*` component and no vendor-official component covers
  tickets, tasks or issue tracking (see the Gate note). Hosted products such as
  Vercel Board are not Convex components.

### The running example

A customer writes in about a double charge. A support agent (AI) opens a ticket
in the `billing` queue. A billing agent (AI) claims it and needs the order
number, so it asks the requester. A human approves the refund through a child
ticket in `approvals`. The ticket resolves with a typed result the support agent
reads as data. The example app in `example/` runs this flow end to end.

```
Support agent        Billing agent          Human approver
     |                    |                       |
  open ------------------>|                       |
     |               claim (wins)                 |
     |<----------- requestInput (waits)           |
  reply (orderId) ------->|                       |
     |               open child, hold on it ----->|
     |                    |                   claim, resolve
     |               (resumes by itself) <--------|
     |               resolve (typed result)       |
  get -> result.refunded                          |
```

## One core, three layers

```
   board layer        desk layer          projects layer      <- host code, presets
   -------------------------------------------------------
              @vllnt/convex-tickets (the core)
   work item, queue, named states in six categories, typed fields and
   result, claim with an optional lease, assign, thread, links and
   blockers, parent and child, history, host hook
```

| Layer    | The core provides                                                                                           | The layer adds                                                                                 | Stays out of both                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Board    | Queues. A claim one caller wins, with a lease. "Claim next" that skips blocked items. Thread, typed result. | `agentQueue()`. The tools served over MCP or HTTP by the host.                                 | A CLI. Chat with no task. Sync with Slack, GitHub or Linear.           |
| Desk     | Requester and holder. Public and internal messages. Waiting on the requester. Reopen window. Due time.      | `deskQueue()`. Intake from email or chat. Canned replies. A business-hours clock.              | Satisfaction surveys, skill-based routing, a knowledge base, a UI kit. |
| Projects | A backlog category. Named states per queue. Assign. Blockers. Parent and child. Labels as links.            | `projectQueue()`. Projects as parent tickets. Cycles as links. Order and views in host tables. | Roadmaps, time tracking, Git integration, a mirror of Linear.          |

A layer ships as a preset helper passed to `defineQueue` plus an example. It
becomes its own package only when a second app needs the same layer.

### The rule for the core

A feature enters the core only if at least two of the three layers need it, and
only if it changes who holds an item, its state, its thread, its typed data or
its links. Everything else belongs to a layer or to the host.

| Candidate                                   | Verdict                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Named states per queue                      | Core. Names are strings grouped by category.                                    |
| A lease that can be off                     | Core. `policy.leaseMs: null`.                                                   |
| Assignment by someone else                  | Core. The `assign` move.                                                        |
| Several prerequisites                       | Core. `blocks` links and a counter.                                             |
| Backlog (recorded, not yet claimable)       | Core. One category.                                                             |
| Labels                                      | Core, at no cost. A link with `refKind: "label"`. Work is routed by queue.      |
| Estimates                                   | No core concept. A queue declares a number field.                               |
| Projects, cycles, saved views               | Layer. A project is a parent ticket. A cycle is a link with `refKind: "cycle"`. |
| A sortable rank for manual order            | Out for now (decision 8). The layer keeps order in a host table.                |
| Chat that is not tied to a task             | Out. Use `@convex-dev/agent` threads.                                           |
| HTTP, CLI or MCP surface for outside agents | Split. The tool definitions are core. Serving them is the host's job. No CLI.   |

## Concepts

| Term       | Meaning                                                                                                                             | In the refund example                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Party      | Anyone who can act on a ticket: an opaque `ref` plus a kind hint. The component never branches on the kind.                         | `agent:support`, `agent:billing`, `user:ines` |
| Queue      | A named place where work lands. It carries the field definitions, the named states and a policy.                                    | `billing`, `approvals`                        |
| Ticket     | One unit of work: a queue, a state, a requester, at most one assignee, typed fields and a history.                                  | "Refund for a double charge"                  |
| State      | The name a queue gives one step, such as `pending`. The host chooses the names.                                                     | `working`                                     |
| Category   | One of six fixed groups. Every state belongs to exactly one. The rules read the category and ignore the name.                       | `started`                                     |
| Message    | One entry in the thread. `public` messages are for the requester. `internal` messages are notes between the parties doing the work. | "Which order was charged twice?"              |
| Claim      | Taking a ticket so that you alone hold it. With a lease, the claim has a time limit.                                                | The billing agent claims it                   |
| Lease      | A deadline on a claim. If the holder does not renew, the ticket goes back to the queue.                                             | 5 minutes on `billing`                        |
| Fence      | `claimSeq`: a number that rises each time the holder changes. A write that carries an old number is refused.                        | `CLAIM_LOST` for the old holder               |
| Assign     | Setting the assignee from outside. A host move.                                                                                     | A lead gives the approval to `user:ines`      |
| Blocker    | A ticket that must be completed before another one can start or go on.                                                              | The approval blocks the refund                |
| Handoff    | Passing a ticket to another queue or to a named party. Each handoff counts as one hop.                                              | Billing passes a tax question to finance      |
| Result     | The typed outcome written when a ticket resolves. The requester reads it as data.                                                   | `{ refunded: true, refundId: "re_301" }`      |
| Seal       | `closedAt`: a one-way latch on a done or canceled ticket. A sealed ticket takes no more writes.                                     | Set when the reopen window ends               |
| Transition | One row of history: what changed, from which state to which, who did it, when.                                                      | `claimed` by `agent:billing`                  |

## Status model

The component fixes six categories. Each queue declares its own states and maps
each one to a category. Rules, guardrails and timers read only the category.
Names are for people and screens.

```
 main path:   backlog --> unstarted --> started --> done
                                          |  ^
 pause:                                   v  |
                                        waiting
 exit, from any category before done:    canceled
```

| Category    | The rule only it has                                                     | Default state |
| ----------- | ------------------------------------------------------------------------ | ------------- |
| `backlog`   | "Claim next" never returns it. Someone must accept it first.             | none          |
| `unstarted` | Claimable, unless a blocker is open or it is reserved for another party. | `open`        |
| `started`   | Must have a holder. The lease runs here.                                 | `working`     |
| `waiting`   | Keeps the holder, stops the lease. An attribute says what ends the wait. | `waiting`     |
| `done`      | Needs a resolution. Clears the blockers it holds when it is `completed`. | `resolved`    |
| `canceled`  | No result. Never clears a blocker.                                       | `canceled`    |

### Kept out of the category set on purpose

| Thing                                               | Stored as                                                        | Why it is not a category                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Waiting on the requester, on blockers, or elsewhere | `waitingOn` on the ticket: `requester`, `blockers` or `external` | The three share every rule but one: what ends the wait. A requester reply ends the first, the last blocker the second, an explicit `resume` the third. |
| Closed                                              | `closedAt`, a seal on a done or canceled ticket                  | It is a one-way latch set by a timer, with no moves of its own.                                                                                        |
| Blocked                                             | `openBlockers`, a counter                                        | A blocked ticket stays where it is. The counter stops claim and nothing else.                                                                          |
| Triage, failed, rejected, duplicate                 | A named state, a resolution, or a `duplicates` link              | No rule differs, so extra categories would only repeat the final-state rules.                                                                          |

### Named states

- Names are runtime data. The state is stored as a string and checked against
  the queue definition on every write. An unknown name is `UNKNOWN_STATE`. The
  category is stored next to it.
- Names are typed at compile time. The client class is generic over the host's
  queue definitions, so a misspelled state does not compile.
- Every verb has a landing state: the first state declared in a category. A verb
  takes an optional `to` that names another state of the same category. A
  waiting state may declare `on: "requester"` or `on: "external"`.
- `move` changes the state inside one category, or between `backlog` and
  `unstarted`. Every other boundary keeps its own verb.
- A queue with no states gets five: `open`, `working`, `waiting`, `resolved`,
  `canceled`. A queue that declares its own must cover `unstarted`, `started`,
  `done` and `canceled`. A verb that targets a missing category is refused
  (`NO_LANDING_STATE`).
- States only grow. A state's category never changes after the first `sync`. A
  state cannot be removed while a ticket is in it.

## Allowed moves and who may make them

The component is auth-agnostic. It cannot know whether a caller may use a queue.
It checks the caller's relation to the ticket: is this party the holder, the
requester, and does its claim number still match. The host gates everything else
before it calls in.

| Move           | From to                                                                   | Who                                                   |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `open`         | New ticket in `unstarted` (or `backlog` with `to`)                        | Any party the host lets in                            |
| `move`         | Within one category, or `backlog` and `unstarted`                         | The holder if held, else the host                     |
| `assign`       | Any category before `done`. The state stays                               | Host                                                  |
| `claim`        | `unstarted` to `started`                                                  | Any party the host lets in                            |
| `renew`        | `started` to `started`                                                    | Holder                                                |
| `release`      | `started` to `unstarted`                                                  | Holder, or trusted host                               |
| lease expiry   | `started` to `unstarted` (or escalated)                                   | System timer                                          |
| `requestInput` | `started` to `waiting` on the requester                                   | Holder                                                |
| `reply`        | `waiting` on the requester to `started`                                   | The requester. Otherwise it only adds a message       |
| `hold`         | `started` to `waiting` on blockers or on something external               | Holder                                                |
| `resume`       | `waiting` to `started`                                                    | Holder, trusted host, or the system when blockers end |
| `handoff`      | `started` to `unstarted` in another queue, or `started` for a named party | Holder                                                |
| `resolve`      | `started` to `done`                                                       | Holder                                                |
| `reopen`       | `done` or `canceled` to `unstarted`, before the seal                      | The requester, or trusted host                        |
| `close`        | Seals a `done` or `canceled` ticket                                       | Host, or the system at the window end                 |
| `cancel`       | Any category before `done` to `canceled`                                  | The requester, or trusted host                        |
| `escalate`     | Any category before `done` to `unstarted` in `escalateTo`                 | Holder, trusted host, or the system                   |

"Host" moves are client methods that the host calls only from trusted code. The
`trusted` flag on `release`, `resume`, `reopen`, `cancel`, `escalate` and `move`
lets host code make a holder move for anyone. A trusted call still has to fit
the verb's categories. Host moves are left out of the agent tool set.

**Guard order for holder writes.** A stale `claimSeq` is `CLAIM_LOST`. A ticket
in a category the verb does not accept is `INVALID_MOVE`. A caller who is not
the holder is `NOT_HOLDER`. In a lease queue, an expired lease on a started
ticket is `CLAIM_LOST`.

## Leases and the fence

- **Lease on.** `policy.leaseMs` is a number, five minutes by default. An agent
  that crashes stops renewing, and a timer returns the ticket to the queue. This
  is the right default for agents.
- **Lease off.** `policy.leaseMs: null`. The holder keeps the ticket until they
  release it, hand it off, resolve it, or someone reassigns it. No `leases` row
  is written and no timer runs. A queue worked by people and a project queue use
  this. The cost: nothing takes a ticket back from a person who went silent. The
  due time, escalation and `assign` are the only backstops.
- **The fence stays in both modes.** `claimSeq` starts at 0 on open and rises on
  claim, release, `assign` (when the assignee changes), handoff, reopen,
  escalate and lease expiry. It does not change on `hold`, `resume`,
  `requestInput`, `reply`, `move` or `resolve`. A write that carries an old
  number is refused, which makes reassignment safe without a lease.
- **Assignment is its own move.** On a ticket nobody has started, the assignee
  is a reservation: only that party can claim it, and "claim next" returns a
  party's reserved tickets first. On a started ticket, `assign` replaces the
  holder and restarts the lease, if any. Clearing the assignee of a started or
  waiting ticket is `HOLDER_REQUIRED`.
- **A started ticket always has a holder** (decision 7). A screen that drags an
  unassigned card to "In progress" calls `claim` as the person who dragged it.
- **Renewal** writes only the `leases` row, so a heartbeat does not re-run every
  query that reads the ticket.

## Blockers

A `blocks` link from A to B means B cannot start until A is completed.

- **A counter keeps reads bounded.** B carries `openBlockers`, the number of its
  blockers that are not completed yet. It is written in the same transaction as
  the link, or as the blocker's resolve.
- **"Claim next" skips blocked tickets** with no extra read: it reads the index
  range for the queue, category `unstarted` and `openBlockers` 0. A direct claim
  on a blocked ticket returns `BLOCKED`.
- **Only `completed` clears a blocker** (decision 10). Each ticket it blocks
  loses one from its counter. At zero, an unheld ticket gets an `unblocked`
  event so the host can wake a worker. A held ticket that waits on its blockers
  resumes.
- **Any other ending clears nothing.** If a blocker fails, is rejected or is
  canceled, each dependent gets a `blocker_failed` event. A held dependent that
  waits on blockers resumes at once so its holder can decide. An unheld one
  stays blocked until the blocker is reopened or the link is removed. A new link
  (`open` with `blockedBy`, `hold`, `link`) to a blocker that has already ended
  without completing is refused with `INVALID_ARGUMENT`: it could never clear.
- **Caps.** At most 20 blockers per ticket, and one ticket blocks at most 100.
  Adding a link walks the chain upstream to refuse a cycle (`CYCLE`). The walk
  stops at 200 tickets (`GRAPH_TOO_DEEP`). These are the defaults and also the
  ceilings (`LIMIT_CEILINGS`): `sync` refuses a higher value. Every read of
  blocker links takes up to the ceiling, so lowering a limit later never hides a
  link that exists; the lower value only stops new links past it.
- **Parent and blocker are different things.** `parentId` means "part of".
  `blocks` means "must finish first". The refund's approval is both.
- `hold` with a list of blockers adds the links and waits on them. The last
  blocker completing resumes the ticket by itself.

## Threads

- The thread is a flat, append-only list: no replies to replies, no edits. The
  component owns it (decision 2), because the state machine reads and writes
  messages: a requester reply moves the state, timers write system notes, and
  the message cap is a guardrail.
- A message has a `visibility` (`public` or `internal`), a `kind` (`message`,
  `input_request` or `system`), a body and optional `data` (the fields a reply
  supplied).
- Reads return public messages unless the host asks for `view: "internal"`. The
  component does not check who asks; the host gates the internal view.
- `requestInput` adds an `input_request` message, stores the `requestedFields`
  on it, and moves the ticket to a waiting state with `waitingOn: "requester"`.
- A reply by the requester to an input request checks its fields, merges them
  into the ticket and returns the ticket to `started`. In any other case a reply
  only adds a message. A plain reply never reopens a ticket, so a thank-you
  message cannot restart work.
- `get` returns the newest 20 messages. `listMessages` pages the rest.
- Idempotency: a repeated `idempotencyKey` on `reply` returns the first message
  and writes nothing.

## Guardrails

Agents write faster than people and do not get bored. Every limit below is a
queue policy value or a mount limit with a default. All default numbers are
starting guesses.

| Guardrail                  | Default                                                             | When it trips                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hop limit                  | 6 handoffs per ticket                                               | `handoff` returns `HOP_LIMIT` and the ticket escalates (once, if the queue has `escalateTo`). Without an escalation the trip is recorded as `guardrail_tripped`. |
| Ping-pong                  | A target that gave the ticket away twice in its last 50 transitions | `handoff` returns `PING_PONG`, then escalates as above.                                                                                                          |
| Message cap                | 200 messages per ticket                                             | `reply` returns `MESSAGE_LIMIT` and escalates as above. `requestInput` and `resolve` with a body throw `MESSAGE_LIMIT`.                                          |
| Rate limit per party       | 30 opens and 120 messages per minute                                | `RATE_LIMITED` with `retryAt`. Uses `@convex-dev/rate-limiter` as a child component. Messages: `reply`, `requestInput`, `resolve` with a body.                   |
| Open tickets per requester | 50 per queue                                                        | `TOO_MANY_OPEN`, on `open` and `reopen`. Bounded index reads, no counter table.                                                                                  |
| Blockers                   | 20 per ticket, 100 blocked per ticket (ceilings)                    | `TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED`. A link that closes a cycle is `CYCLE`. A blocker that ended without completing is `INVALID_ARGUMENT`.                   |
| Crash loop                 | 3 lease expiries, lease queues only                                 | The ticket escalates, once, instead of returning to the same queue again.                                                                                        |
| Silent holder, no lease    | No automatic return                                                 | The due time emits `due_breached`. Escalation or `assign` moves the ticket.                                                                                      |
| Due time                   | Per queue, off by default                                           | Emits `due_breached` once. Escalates if `escalateOnDue` is true and the ticket never escalated.                                                                  |
| Stale holder               | Always on, with or without a lease                                  | A write with an old `claimSeq` is `CLAIM_LOST`.                                                                                                                  |
| Visibility                 | Reads return public messages                                        | Internal notes only for `view: "internal"`.                                                                                                                      |
| Idempotency                | Optional key on `open` and `reply`                                  | A repeat returns the first id and writes nothing.                                                                                                                |

Escalation moves a ticket to the queue named in `escalateTo`. It lands
`unstarted` with no holder, lowers the priority number by one (floor 0), raises
`claimSeq` and sets `escalatedAt`. It does not count as a hop. An agent
escalates on low confidence by calling `handoff` to that queue with a reason.
The component does not measure confidence.

## Timers

Three things need a clock: lease expiry in queues that have a lease, the due
time, and the seal at the end of the reopen window. Each is one scheduled
function set at the moment the deadline is known. When it fires it compares the
stored value (`claimSeq`, `dueAt`, the end time) with the one it was scheduled
for and does nothing if they differ. That makes it safe to run twice and removes
the need for a polling sweep.

- **Lease expiry.** Returns the ticket to `unstarted` (`lease_expired`). A
  renewal reschedules it. After `maxReturns` expiries, and if the queue has
  `escalateTo` and the ticket never escalated, the ticket escalates instead. The
  timer belongs to one lease row (it carries the lease id): a claim, resume or
  handoff makes a new row, and the old timer ends when it fires. It does nothing
  when the queue no longer has a lease.
- **Due time.** Fixed at open (`dueInMs`). Emits `due_breached` once on a ticket
  that is not done or canceled. A reopen sets the timer again when the ticket
  has not breached. The due time is a wall-clock deadline. A clock that counts
  business hours belongs to the desk layer.
- **Seal.** When a ticket reaches `done` or `canceled`, the queue's
  `reopenWindowMs` decides: `0` seals at once, `null` never seals, otherwise a
  timer seals at the end of the window (default 7 days). A reopen before then
  makes the timer do nothing.

## The hook

`onEvent` is a host function reference. `sync` stores it as a function handle.
After every transition the component schedules it (delay 0) with a
`ticketEvent`: the ticket id, the `seq`, the transition type, the queue, state
and category (after the move, and before it when they changed), whether the
ticket is blocked, the priority, the requester, the assignee, `claimSeq`, the
actor, the reason and the time. It carries no message bodies and no fields; the
hook calls `get` for those.

- **Scheduled, not inline.** A hook that throws cannot roll back the ticket
  move. The cost: the hook runs a moment later and may see a newer ticket.
- **One event per transition, with a `seq`.** `seq` counts that ticket's
  transitions from 1 without gaps. The host orders events by `seq`. Delivery
  order is not guaranteed (see "Gaps against the design").
- A hook that serves every queue branches on the event's `category`, never on a
  state name.
- A mount without `onEvent` schedules nothing.
- A veto goes in the host's own function, before it calls the client.

## Retention

Messages and transitions grow without bound, so sealed tickets can be purged. A
daily cron (`tickets:purge`) runs the purge. It does nothing until `retentionMs`
is set through `sync`. With it set, the purge deletes sealed tickets whose
`closedAt` is older than `retentionMs`, with their messages, history and links,
in batches of 200 rows, and reschedules itself until none is left. It is
idempotent. A queue that never seals (`reopenWindowMs: null`) is never purged.

## Schema

All tables live in the component's sandbox. Every reference to the outside world
is an opaque string. Typed values are flat records of scalars (string, number,
boolean or null), so there is no `v.any()`.

| Table         | Holds                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queues`      | The state names and field definitions as plain data, the policy, and a `schemaVersion` raised on each change.                                                                     |
| `tickets`     | One row per work item. Changes only on real moves, so list queries stay calm. Indexes for claim next, assignee, requester, subject, parent, idempotency, seal and a title search. |
| `leases`      | One row while a ticket is started in a queue that has a lease. A queue with the lease off never writes here.                                                                      |
| `messages`    | The thread. Flat and append-only.                                                                                                                                                 |
| `links`       | Edges from a ticket to another ticket or to an outside thing. Blockers and labels live here.                                                                                      |
| `transitions` | Append-only history. Also the input for hop counting and ping-pong detection.                                                                                                     |
| `config`      | One row per mount: the hook handle, `retentionMs` and the limits.                                                                                                                 |

- **Typed fields, end to end.** The client class is generic over the host's
  queue definitions, so fields, result and state names are typed at compile
  time. The component's own validators are static. The component checks each
  write against the queue's stored definition: an unknown key, wrong type,
  missing required field or unknown state is a coded error. Changes to a queue
  definition are additive only.
- **Result fields.** Required result keys are enforced only for `completed`.
- **Tenancy.** There is no scope field. Queue names are runtime data, so a
  multi-tenant host prefixes them. Separate mounts give hard isolation.
- **Where agent data lives.** Work state shared between agents lives on the
  ticket: typed fields, a typed result, internal notes and links. Conversations
  stay in `@convex-dev/agent`, knowledge in `@convex-dev/rag`, files in Convex
  file storage. A link with your own `refKind` (`agentThread`, `file`, `label`,
  `cycle`) points at them.

## What stays closed

- **The six categories.** You name states. You cannot add a category or change a
  category's rule.
- **Flat fields.** A list or a nested object goes in a file or a host table,
  with a link on the ticket.
- **No index on your own fields.** The component cannot sort or filter by a
  custom field. Use a link, which is indexed, or filter in the host.
- **No veto inside the hook.** The hook runs after the move.
- **Queues are defined in code.** `sync` writes them at deploy. Creating a queue
  from an admin screen at runtime is not in 0.1.0.
- **The component never executes work.** No step runner, no retries, no "run
  this function when claimed".

### Boundaries: what the core will not do, and who does

| The core will not                                                            | Who does                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Run an agent or call an LLM                                                  | `@convex-dev/agent`, started by the host                                                                                        |
| Execute, retry or sequence work                                              | `@convex-dev/workflow`, `@convex-dev/workpool`                                                                                  |
| Decide who may see, claim or assign                                          | The host, for example with `@vllnt/convex-permissions`                                                                          |
| Serve tools to agents outside Convex                                         | The host, with `@convex-dev/mcp`, or HTTP actions gated by [`@vllnt/convex-api-keys`](https://github.com/vllnt/convex-api-keys) |
| A CLI, chat with no task, sync with Slack, GitHub or Linear                  | A hosted service such as Vercel Board                                                                                           |
| Ingest email, chat or SMS as tickets, canned replies, a business-hours clock | The desk layer, in host code                                                                                                    |
| Projects, cycles, manual order, saved views, roll-ups                        | The projects layer, in host tables                                                                                              |
| Threaded annotations with edits                                              | A comments component, mounted with the ticket id as the resource                                                                |
| Store knowledge or long-term memory                                          | `@convex-dev/rag`, `@convex-dev/agent`                                                                                          |
| Track or cap spend                                                           | `@convex-dev/ai-budget`                                                                                                         |
| Speak the A2A wire protocol                                                  | A host bridge. The category mapping makes one possible.                                                                         |
| A general key-value store for agents                                         | A separate decision (decision 3)                                                                                                |

## Packages

- **Used:** `@vllnt/eslint-config` (lint), `@vllnt/typescript` (tsconfig base),
  `@convex-dev/rate-limiter` (child component for open and message rate limits).
- **Not used:** `@vllnt/logger` (the component does not log; history and the
  hook replace logs), a private Playwright end-to-end kit (not a fit for
  `convex-test`), `@vllnt/convex-helpers` (nothing it offers is needed),
  `@convex-dev/workpool`, `@convex-dev/agent`, `@convex-dev/mcp` (the example is
  scripted; a host may add them).

## Risks

- **A more abstract core.** Two words for status (state and category), plus an
  attribute, a seal and a counter. Every reader, hook and error message must
  keep them apart.
- **More configuration per queue.** States, their order, the lease, the reopen
  window. The default set and the presets hide this for the simple case.
- **More cases to test.** Each move is tested with the lease on and off, on a
  blocked and an unblocked ticket, on a reserved and an unreserved one, and with
  default and custom states. The blocker counter adds a class of bug: a count
  that drifts from the links.
- **Scope creep.** Three products bring three backlogs of reasonable requests.
  The two-of-three rule is the answer.
- **The foundation claim is unproven.** "Desk and projects need no core change"
  is a design claim until two different example apps run on the same core. The
  Rule of Three needs two real consumers, and none is named (see the Gate note).
- **Pressure from outside.** If `@convex-dev/agent` gains assignment, status or
  handoff, this component narrows to the queue and the typed data, or retires.
  Re-run the overlap check before each minor release.
- **Write volume.** One reply costs a message insert, a ticket patch, sometimes
  a transition and a scheduled hook. Many agents calling "claim next" on one
  queue read the same index range, so they conflict with each other. For a large
  pool, let the hook start one agent per ticket instead of letting all of them
  race.
- **History grows without bound.** Retention is off by default.
- **Flat fields only.** A queue whose work data is a list or nested object does
  not fit. This is accepted to keep `v.any()` out.

## Build order, and where it stands

Each step lands with 100% coverage under `convex-test`.

| Step                                        | Proof required                                                                                                              | State in 0.1.0                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Gate                                        | A dated note in the repo                                                                                                    | Done (the Gate note above)          |
| Queues, states and tickets                  | Unknown key, wrong type, missing field and unknown state are rejected. `sync` is additive. Repeat `open` returns one ticket | Done                                |
| Claim, assign, lease on and off, release    | Of two claims the second gets `TAKEN`. An unrenewed lease returns the ticket. An old `claimSeq` gets `CLAIM_LOST`           | Done                                |
| Messages, `requestInput`, `reply`           | The public view never returns an internal note. A requester reply with fields returns the ticket to started                 | Done                                |
| Blockers                                    | Claim next skips blocked tickets. A canceled blocker clears nothing. Caps and the cycle check are tested at the limit       | Done                                |
| Handoff and guardrails                      | Two parties hand a ticket back and forth until `PING_PONG` trips and it escalates                                           | Done                                |
| Resolve, reopen, seal, cancel               | Every category and move pair, legal and illegal. The refund and project examples run end to end                             | Done                                |
| Hook and the remaining timers               | The hook receives one event per transition, in `seq` order. A hook that throws leaves the move in place                     | Done under `convex-test` (see Gaps) |
| Tools entry, presets and three example apps | A recorded run of each, and a README a stranger can follow                                                                  | Partly: one example app (see Gaps)  |
| First adopter, then canary                  | Real tickets opened and resolved by two different parties                                                                   | Next                                |
| React entry                                 | `useQueue`, `useTicket`, `useThread`                                                                                        | Next, last                          |

## Open decisions

Decision 1 was made by the owner. Decisions 2 to 10 take the design's
recommendation (see "Assumed, owner to confirm").

| #   | Decision                                        | Taken                                                                                                                                                          |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Name                                            | Decided 2026-11-26: `@vllnt/convex-tickets`, component id `tickets`. The README's first line says "work items".                                                |
| 2   | Own the thread, or compose a comments component | Own a flat, append-only `messages` table. Point hosts to a comments component for threaded annotations.                                                        |
| 3   | A general agent data store: in or out           | Out. Use a parent ticket's fields as the shared workspace. Revisit as its own proposal if that is too small.                                                   |
| 4   | Rule-of-Three override, and who adopts first    | Override. Build for the first adopter, publish canary only, hold stable until a second backend runs the core on a different layer. Stop rule in the Gate note. |
| 5   | Hook delivery: scheduled or inline              | Scheduled. A host that needs a veto wraps the client call in its own mutation.                                                                                 |
| 6   | The category set                                | Six categories, with `waitingOn` as an attribute and the seal as `closedAt`.                                                                                   |
| 7   | A started item with no assignee                 | Never. A screen that starts an unassigned card claims it for the person who moved it.                                                                          |
| 8   | A sortable rank for manual order                | Out for now. Add it when the projects layer has a consumer and the host-table join is measured as a problem.                                                   |
| 9   | Agents outside Convex                           | No CLI. The host serves the tools over MCP or HTTP.                                                                                                            |
| 10  | What clears a blocker                           | Only a `completed` resolution. `blocker_failed` tells the host about the rest.                                                                                 |

## Assumed, owner to confirm

These are choices the code makes that the design left open, or that the build
took on its own. Each is a starting position, not a settled decision.

- Decisions 2 to 10 take the design's recommendation, as listed above.
- `reopenWindowMs` defaults to 7 days.
- Required result fields are enforced only for a `completed` resolution.
- `release`, `handoff` and `resolve` work only from `started`.
- Escalation from a refused handoff or a reached message cap happens once per
  ticket (an `escalatedAt` guard).
- A `trusted` flag lets host code make holder moves (`release`, `resume`,
  `reopen`, `cancel`, `escalate`, `move`) for anyone.
- `open` takes an optional first `body`, written as the first public message.
- Input requests store `requestedFields` on the message.
- A `by_requester_queue` index backs the per-requester open cap.
- All default numbers (lease 5 minutes, 6 hops, 3 returns, 200 messages, 50 open
  per requester, 20 blockers, 100 blocked, a walk of 200, 30 opens and 120
  messages per minute) are starting guesses.
- **Guard order for holder writes:** stale `claimSeq` is `CLAIM_LOST`, a wrong
  category is `INVALID_MOVE`, a caller who is not the holder is `NOT_HOLDER`,
  and an expired lease is `CLAIM_LOST`.

## Gaps against the design

Where the code and the design differ, the code is documented as it is. Each gap
is either a difference to confirm or work not done in 0.1.0.

### Not built in 0.1.0

- **No field-update move.** Fields change after `open` only through `reply` (the
  requester answering an input request) and `handoff`. A project queue editing
  an estimate needs a move for it.
- **The board example is scripted.** A scripted agent woken by the hook runs the
  refund. There is no live LLM on `@convex-dev/agent`, no
  `@convex-dev/workpool`, and the tools are not served over `@convex-dev/mcp`.
- **Desk and projects are queues in one example app plus tests**, not separate
  example apps.
- **No React entry** (`./react`).

### Hook delivery order

- **Hook events can arrive out of `seq` order.** The guarantee is one event per
  transition, with a `seq` that counts that ticket's transitions without gaps.
  The host orders by `seq`.
- **The build-step proof "in `seq` order" holds only under `convex-test`**,
  which runs scheduled functions one at a time. On 2026-11-27 the example refund
  flow ran end to end on a real local Convex backend (not `convex-test`). The
  hook got exactly one event per transition, with `seq` 1 to 7. Arrival order
  was `opened` (1), `input_requested` (3), `claimed` (2), `input_provided` (4),
  `held` (5), `resumed` (6), `resolved` (7). Two transitions in one mutation
  schedule two hook runs, and Convex may run them in parallel. This matches the
  design's hook section: the hook is scheduled, it may see a newer ticket, and
  each event has a `seq` so the host can order them. This run is not part of the
  automated tests.
- Ordered per-ticket delivery (an outbox plus an action dispatcher) is an
  optional roadmap item, only if a consumer needs it.

### Differences between the code and the design text

- **`claim` has a fifth reason.** The design lists `TAKEN`, `BLOCKED`,
  `RESERVED` and `EMPTY`. The code adds `NOT_CLAIMABLE` for a ticket that is in
  `backlog`, `done` or `canceled`.
- **`get` takes `view`, not an actor.** The design's sketch passes `actor` to
  `get`. The code takes `view` (`public` or `internal`) and an optional `queue`,
  and the host gates who may ask for the internal view.
- **Result and field types are partial.** The design shows a result typed
  `{ refunded: boolean; refundId?: string }`. The typed client reads a field as
  `T | null | undefined`, because a reply and a handoff may write `null` to
  clear a field.
- **Guardrail trips are results, and a trip that returns leaves a row.** The
  design says every trip is recorded as a transition. In the code a refused
  handoff or a reached message cap in `reply` is a returned result. It writes an
  `escalated` transition when the ticket escalates, and a `guardrail_tripped`
  transition (the code and a short text as `reason`, no other change) when it
  does not. `RATE_LIMITED`, `TOO_MANY_OPEN` and the other thrown codes leave no
  row: the call rolls back.
- **`requestInput` and `resolve` with a body throw at the message cap**, while
  `reply` returns a result. The message rate limit applies to all three.
- **`escalate` is a holder or trusted-host move.** The design says "system, or
  holder". The system escalates through timers and refusals; a direct call is
  made by the holder (with `claimSeq`) or by the host with `trusted`.
- **`release` is for the holder or a trusted host.** The design lists "holder,
  host, or system"; the system path is the lease timer.
- **`hold` can wait on blockers already linked.** With `waitingOn: "blockers"`
  and no list, the ticket waits on the blockers it has. The design only lists
  the list form and the external wait.
- **More mount limits.** The design's `config.limits` has five values
  (`maxBodyChars`, `maxFields`, `maxStringChars`, `maxBlockers`, `maxBlocked`).
  The code has eight: it adds `maxGraphWalk`, `opensPerMinute` and
  `messagesPerMinute`.
- **A few indexes differ in shape.** `links.by_ticket` also covers `toTicketId`,
  and `links.by_ref` also covers `ticketId`. These are implementation details
  with no effect on the API.
- **`list` also filters by parent.** The design lists queue, assignee, requester
  and subject. A filter on state and category together is refused
  (`INVALID_ARGUMENT`).

### Not verified

- The Vercel Board, Linear and A2A facts in the design come from public docs
  read on 2026-11-26. This repository does not re-check them.
- Patching a ticket row re-runs every query that read it. That is how Convex
  reactivity is documented to work. It was not measured here.
- All default numbers are starting guesses. None was measured against real
  traffic.
