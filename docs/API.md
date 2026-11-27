# API Reference — @vllnt/convex-tickets

**Compatibility:** requires `convex@^1.45.0`.

0.1.0 is a canary release. The API may change before a stable 0.1.0.

## Package exports

| Import path                                          | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vllnt/convex-tickets`                              | `Tickets` class; functions `defineQueue`, `toQueueDef`, `toValues`, `isTicketsError`; validators `ticketEvent` (a field map, for `args`), `ticketEventValidator`, `partyValidator`, `scalarValidator`, `scalarRecordValidator`; constants `CATEGORIES`, `TRANSITION_TYPES`, `ERROR_CODES`, `DEFAULT_POLICY`, `DEFAULT_LIMITS`, `LIMIT_CEILINGS`, `DEFAULT_STATES`, `SYSTEM_PARTY`; types `TicketsOptions`, `EventHandler`, `TicketView`, `TicketDetail`, `TypedTicket`, `ClaimResult`, `ReplyResult`, `HandoffResult`, `MoveResult`, `ListFilter`, `Category`, `Limits`, `Party`, `PartyKind`, `Resolution`, `Scalar`, `ScalarRecord`, `TicketEvent`, `TicketsErrorCode`, `TicketsErrorData`, `TransitionType`, `Visibility`, `WaitingOn`, `AnyQueue`, `FieldSpec`, `FieldsSpec`, `FieldValues`, `PartialFieldValues`, `PolicyInput`, `QueueDefinition`, `QueueMap`, `StateName`, `StateSpec`, `StatesSpec`, `RunMutationCtx`, `RunQueryCtx` |
| `@vllnt/convex-tickets/presets`                      | `agentQueue`, `deskQueue`, `projectQueue`, `DESK_STATES`, `PROJECT_STATES`; type `PresetOptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@vllnt/convex-tickets/tools`                        | `ticketTools`, `TOOL_NAMES`; types `TicketTool`, `ToolBinding`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@vllnt/convex-tickets/test`                         | `register(t, name = "tickets")` to mount the component and its rate-limiter child in `convex-test`, plus a default export `{ register, schema, modules }` (TypeScript source; needs Vite's `import.meta.glob`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@vllnt/convex-tickets/convex.config` (`.js`)        | default: the component definition, passed to `app.use()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@vllnt/convex-tickets/_generated/component` (`.js`) | type `ComponentApi` (the type of `components.tickets`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@vllnt/convex-tickets/package.json`                 | the package manifest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`RunMutationCtx` is any context with `runMutation` and `runQuery` (mutation or
action). `RunQueryCtx` is any context with `runQuery`.

## Conventions

- **Party.** Every write takes
  `actor: { ref: string, kind: "human" | "agent" | "system" }`. The component
  trusts `ref` and never branches on `kind`. The component acts as
  `SYSTEM_PARTY` (`{ ref: "system:tickets", kind: "system" }`) for timers and
  automatic moves.
- **Ids** are strings.
- **Fence.** Holder writes carry `claimSeq`, the number `claim` returned.
  `claimSeq` starts at 0 on open and rises by one on claim, release, an `assign`
  that changes the assignee, handoff, reopen, escalate and lease expiry. It does
  not change on hold, resume, requestInput, reply, move or resolve.
- **Guard order for holder writes.** Stale `claimSeq` throws `CLAIM_LOST`. A
  ticket in the wrong category throws `INVALID_MOVE`. A caller who is not the
  holder throws `NOT_HOLDER`. In a lease queue, an expired lease on a started
  ticket throws `CLAIM_LOST`.
- **Losing a race is a result.** `claim`, `reply` and `handoff` return a result
  union for the expected refusals. Every other failure throws a coded error (see
  [Errors](#errors)).
- **Host moves.** `assign` and `close` are for trusted host code. The `trusted`
  flag on `release`, `resume`, `reopen`, `cancel`, `escalate` and `move` lets
  host code act for anyone. Never expose them as agent tools. A trusted call
  still has to fit the verb's categories.
- **`queue` argument.** Verbs that take an optional `queue` use it to narrow
  `to` and `fields` at compile time. At runtime a `queue` that does not match
  the ticket's queue throws `WRONG_QUEUE`.
- **`null` clears an optional field.** `null` is never stored. A required field
  cannot be cleared (`MISSING_FIELD`).
- **Internal notes.** `view: "internal"` returns internal messages. The
  component does not check who asks. The host gates it.

## Tickets class

```ts
import { Tickets, defineQueue } from "@vllnt/convex-tickets";
import { components, internal } from "./_generated/api";

const tickets = new Tickets(components.tickets, {
  queues: { billing: defineQueue({ fields: { amount: { type: "number" } } }) },
  onEvent: internal.ticketHooks.onEvent, // optional
  limits: { opensPerMinute: 60 }, // optional
  retentionMs: 30 * 24 * 60 * 60_000, // optional
});
```

| Option        | Type                | Description                                                            |
| ------------- | ------------------- | ---------------------------------------------------------------------- |
| `queues`      | `Record<string, Q>` | Every queue of this mount, by name                                     |
| `onEvent`     | internal function   | A mutation or action taking `ticketEvent`. Stored as a function handle |
| `limits`      | `Partial<Limits>`   | Mount-wide limits. See [Defaults](#defaults)                           |
| `retentionMs` | `number`            | Purge sealed tickets this long after they were closed. Off by default  |

The instance has `component` (the function references) and `queues` (the
definitions it was built with).

### defineQueue({ states?, fields?, result?, policy? })

Returns the same definition with state names and field types kept as literal
types. A queue with no `states` gets the five defaults.

```ts
const eng = defineQueue({
  states: {
    backlog: { category: "backlog" },
    todo: { category: "unstarted" },
    in_progress: { category: "started" },
    in_review: { category: "started" },
    done: { category: "done" },
    canceled: { category: "canceled" },
  },
  fields: { estimate: { type: "number" } },
  policy: { leaseMs: null, reopenWindowMs: null },
});
```

| Part     | Shape                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `states` | `Record<name, { category, on? }>`. Order sets the landing state. `on` (`"requester"` or `"external"`) is for `waiting` only |
| `fields` | `Record<key, { type: "string" \| "number" \| "boolean", required? } \| { type: "enum", options, required? }>`               |
| `result` | Same shape as `fields`. Checked when a ticket resolves                                                                      |
| `policy` | See below                                                                                                                   |

A queue that declares its own states must cover `unstarted`, `started`, `done`
and `canceled`. `backlog` and `waiting` are optional. A verb that needs a
category the queue lacks throws `NO_LANDING_STATE`.

Field values are scalars: a string, a finite number, a boolean or `null`. Nested
data and lists do not fit; keep them in a file or a host table and link them.
The client throws `INVALID_FIELD` for any other value in `fields` or `result`
(it does not drop it), and leaves a key set to `undefined` unset. A field or
result key must be non-empty printable ASCII and must not start with `$` or `_`.

| Policy key            | Type             | Default (`DEFAULT_POLICY`) | Meaning                                                                             |
| --------------------- | ---------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `leaseMs`             | `number \| null` | `300000` (5 minutes)       | Lease length. `null` turns the lease off                                            |
| `dueInMs`             | `number`         | off                        | Wall-clock due time after open                                                      |
| `reopenWindowMs`      | `number \| null` | `604800000` (7 days)       | How long a done or canceled ticket may be reopened. `0` seals at once, `null` never |
| `maxHops`             | `number`         | `6`                        | Handoffs per ticket                                                                 |
| `maxReturns`          | `number`         | `3`                        | Lease expiries before the ticket escalates                                          |
| `maxMessages`         | `number`         | `200`                      | Messages per ticket                                                                 |
| `maxOpenPerRequester` | `number`         | `50`                       | Active tickets one requester may have in this queue                                 |
| `escalateTo`          | `string`         | none                       | The queue that escalations go to                                                    |
| `escalateOnDue`       | `boolean`        | `false`                    | Escalate when the due time passes, not only emit `due_breached`                     |

### sync(ctx)

Write queues, state names, field types, limits and the hook handle into the
component. Run once per deploy from an internal mutation.

**Returns:** `{ created: string[], updated: string[], unchanged: string[] }`
(queue names).

- Additive only. A state's category cannot change (`STATE_CATEGORY_CHANGED`). A
  state that still has tickets cannot be dropped (`STATE_IN_USE`). A field
  cannot be removed, change type or lose an enum option (`FIELD_CHANGED`).
- A bad definition throws `INVALID_QUEUE`: unsupported queue name (letters,
  digits, `_ : . -` and spaces, starting with a letter or digit), an empty or
  repeated state name, `on` on a non-waiting state, a missing required category,
  a repeated field or result key, or one that Convex cannot store as a record
  key (it must be non-empty printable ASCII, 0x20 to 0x7E, and must not start
  with `$` or `_`), an enum without options (or options on a non-enum), a
  negative or non-finite policy number, `leaseMs: 0`, an `escalateTo` that is
  the queue itself or is not a defined queue, or two queues with one name.
- `leaseMs` cannot switch between a number and `null` while the queue has a
  `started` ticket (`INVALID_QUEUE`): a ticket started without a lease would
  never expire, and a leased one would lose its way back. Changing the length of
  a lease is allowed. With no ticket started, either switch is allowed.
- `escalateTo` may name a queue that this call does not list, if it was synced
  before.
- Queues missing from the call are left as they are.
- `sync` replaces the mount config (limits, hook handle, `retentionMs`) each
  time. Limits you do not pass go back to their defaults, so call it from one
  place with the same options. Each changed queue raises its `schemaVersion` by
  one.
- `limits` values must be positive integers and `retentionMs` a positive finite
  number, else `INVALID_ARGUMENT`. `maxBlockers`, `maxBlocked` and
  `maxGraphWalk` must also be at most their `LIMIT_CEILINGS` (20, 100 and 200).

## Methods

Mutations take a `RunMutationCtx`. Queries take a `RunQueryCtx`. All return
promises.

### open(ctx, args)

Open a ticket. Returns the ticket id (`string`). It lands in the first
`unstarted` state, or in `to`. Writes the `opened` transition, sets the due
timer if the queue has `dueInMs`, and schedules the hook.

| Param            | Type              | Required                          | Description                                                                          |
| ---------------- | ----------------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `queue`          | `string`          | yes                               | Queue name                                                                           |
| `actor`          | `Party`           | yes                               | The requester                                                                        |
| `title`          | `string`          | yes                               | Not empty. At most `maxStringChars`                                                  |
| `fields`         | record of scalars | if the queue has a required field | Checked against the queue. Required keys must be present                             |
| `to`             | state name        | no                                | An `unstarted` or `backlog` state. Default: the first `unstarted` state              |
| `priority`       | integer 0 to 4    | no                                | `0` is urgent. Default `2`                                                           |
| `subjectRef`     | `string`          | no                                | What the ticket is about, such as a host record                                      |
| `parentId`       | `string`          | no                                | A parent ticket. Must exist                                                          |
| `blockedBy`      | `string[]`        | no                                | Tickets that must complete first. A blocker that is already completed does not count |
| `idempotencyKey` | `string`          | no                                | A repeat by the same `actor.ref` returns the first ticket's id and writes nothing    |
| `body`           | `string`          | no                                | The first public message. At most `maxBodyChars`                                     |

Per-party rate limit (`opensPerMinute`) and the per-requester cap
(`maxOpenPerRequester`) apply. The idempotency key is scoped to the requester
across the whole mount, not to one queue. A `blockedBy` ticket that already
ended without completing (`failed`, `rejected` or `canceled`) throws
`INVALID_ARGUMENT`, since it can never clear. A sealed blocker throws `SEALED`,
even a completed one.

### get(ctx, { ticketId, view?, queue? })

Read one ticket. **Returns:** `TicketDetail | null`.

```ts
{
  ticket: TicketView;
  leaseExpiresAt?: number;      // only while a lease runs
  links: LinkView[];            // up to 100
  blockers: BlockerView[];      // up to 100
  messages: MessageView[];      // the newest 20, oldest first
}
```

`view: "internal"` includes internal notes. `queue` throws `WRONG_QUEUE` on a
mismatch. Page older messages with `listMessages`.

`BlockerView` is
`{ linkId, ticketId, state, category, resolution?, completed }`. `completed` is
true only for a `done` ticket with resolution `completed`.

### list(ctx, { filter, paginationOpts })

Page through tickets. Each filter reads one index range. **Returns:** a Convex
pagination result of `TicketView`.

| `filter`                                       | Notes                                                    |
| ---------------------------------------------- | -------------------------------------------------------- |
| `{ by: "queue", queue, state?, category? }`    | `state` and `category` together throw `INVALID_ARGUMENT` |
| `{ by: "assignee", assigneeRef, category? }`   |                                                          |
| `{ by: "requester", requesterRef, category? }` |                                                          |
| `{ by: "subject", subjectRef }`                |                                                          |
| `{ by: "parent", parentId }`                   |                                                          |

### search(ctx, { text, queue?, category?, limit? })

Full-text search over titles. `limit` is an integer from 1 to 100 (default 20),
else `INVALID_ARGUMENT`. **Returns:** `TicketView[]`.

### listMessages(ctx, { ticketId, view?, paginationOpts })

Page through the thread, oldest first. Public messages unless
`view: "internal"`. **Returns:** a pagination result of `MessageView`.

### listTransitions(ctx, { ticketId, paginationOpts })

Page through the history, oldest first. **Returns:** a pagination result of
`TransitionView`.

### listByRef(ctx, { refKind, ref, paginationOpts })

Every link to one outside thing, such as every ticket with a label or the ticket
that belongs to an agent thread. **Returns:** a pagination result of `LinkView`.

### getQueue(ctx, { name })

The stored definition of one queue, or `null` before `sync`. **Returns:**
`{ name, states, fields, resultFields, policy, schemaVersion, updatedAt } | null`.

### claim(ctx, { actor, ticketId?, queue?, to? })

Take a named ticket, or the next claimable one in `queue`. One transaction: of
two racing callers exactly one wins. Needs `ticketId` or `queue`, else
`INVALID_ARGUMENT`. `to` picks a `started` state (default: the first).

"Next" means `unstarted`, no open blocker, and either reserved for the caller
(tried first) or unassigned, lowest `priority` number first, then oldest.

**Returns:** `ClaimResult`. See [Result unions](#result-unions). On a named
ticket the caller already holds, the result is `ok: true` with the current
`claimSeq`.

### renew(ctx, { ticketId, actor, claimSeq })

Extend the holder's lease on a `started` ticket. **Returns:**
`{ expiresAt: number | null }`. `null` in a queue without a lease.

### release(ctx, { ticketId, actor, claimSeq?, trusted?, to?, reason? })

Give a `started` ticket back to its queue. Clears the holder and raises
`claimSeq`. Lands in the first `unstarted` state, or `to`. `claimSeq` is
required unless `trusted`, else `INVALID_ARGUMENT`. **Returns:** `MoveResult`.

### assign(ctx, { ticketId, actor, assignee, reason? })

Host move. Set the assignee (`Party`) or clear it (`null`) on a ticket in any
category before `done`. Raises `claimSeq`.

- On an `unstarted` or `backlog` ticket the assignee is a reservation: only that
  party can claim it, and "claim next" returns a party's reserved tickets first.
- On a `started` ticket it replaces the holder and restarts the lease, if any.
  The old holder's next write gets `CLAIM_LOST`.
- Clearing the assignee of a `started` or `waiting` ticket throws
  `HOLDER_REQUIRED`. Use `release`.
- Assigning the current assignee does nothing.

**Returns:** `MoveResult`.

### move(ctx, { ticketId, actor, to, queue?, claimSeq?, trusted? })

Change the state inside one category, or between `backlog` and `unstarted`.
Moving to a state in another category throws `INVALID_MOVE`. A held ticket
(`started` or `waiting`) needs the holder's `claimSeq`, or `trusted`. On a
`waiting` ticket, `to` must fit what the ticket waits on. A ticket that is not
held needs no claim number: the host decides who may call. Moving to the current
state does nothing. **Returns:** `MoveResult`.

### requestInput(ctx, { ticketId, actor, claimSeq, body, fields?, to?, queue? })

The holder asks the requester for input. Adds an `input_request` message
(public) and moves the ticket to a `waiting` state with
`waitingOn: "requester"`. The lease stops. The landing state is a waiting state
with `on: "requester"`, else one with no `on`. `fields` names queue fields the
requester should supply; an undeclared key throws `UNKNOWN_FIELD`. The names are
stored on the message as `requestedFields`.

Throws `MESSAGE_LIMIT` when the ticket already has `maxMessages` messages, and
`RATE_LIMITED` when the party is over `messagesPerMinute`. Either way nothing
changes. **Returns:**
`{ queue, state, category: "waiting", claimSeq, messageId }`.

### reply(ctx, { ticketId, actor, body, visibility?, fields?, idempotencyKey?, queue? })

Add a message to the thread. `visibility` is `"public"` (default) or
`"internal"`.

- If the ticket waits on the requester and `actor` is the requester, the reply
  is the answer. Its `fields` are checked, merged into the ticket (`null` clears
  a key), and the ticket returns to a `started` state with a fresh lease. The
  transition is `input_provided`.
- In any other case a reply only adds a message. It never reopens or restarts
  work. Supplying `fields` there throws `FIELDS_NOT_ACCEPTED`.
- A repeated `idempotencyKey` on the same ticket returns the first message's id
  with `duplicate: true` and writes nothing.
- A per-party rate limit (`messagesPerMinute`) applies to `reply`,
  `requestInput` and `resolve` with a `body`.
- At `maxMessages` the reply is refused with a result (not a throw), and the
  ticket escalates once if its queue has `escalateTo`. When it does not escalate
  (no `escalateTo`, already escalated, or the ticket is `done` or `canceled`),
  the refusal is recorded as a `guardrail_tripped` transition.

**Returns:** `ReplyResult`. See [Result unions](#result-unions).

### hold(ctx, { ticketId, actor, claimSeq, blockers?, waitingOn?, to?, reason? })

The holder pauses work. The ticket moves from `started` to `waiting`, keeps its
holder and loses its lease.

- With `blockers`, it adds `blocks` links from each blocker to this ticket and
  waits on them (`waitingOn: "blockers"`).
- With `waitingOn: "blockers"` and no list, it waits on blockers already linked.
- Otherwise it waits on something external (`waitingOn: "external"`) until
  `resume`.

If it would wait on blockers but none is open, it throws `NOT_BLOCKED`. A
blocker that already ended without completing (`failed`, `rejected` or
`canceled`) throws `INVALID_ARGUMENT`, since it can never clear (`SEALED` once
it is sealed); a completed blocker is accepted and does not count as open. The
last blocker completing resumes the ticket by itself. **Returns:** `MoveResult`.

### resume(ctx, { ticketId, actor, claimSeq?, trusted?, to?, reason? })

Return a `waiting` ticket to a `started` state and restart the lease. Holder, or
`trusted`. **Returns:** `MoveResult`.

### handoff(ctx, { ticketId, actor, claimSeq, toQueue?, toParty?, fields?, reason? })

Pass a `started` ticket on. Needs `toQueue`, `toParty` or both, else
`INVALID_ARGUMENT`. Counts one hop and raises `claimSeq`.

- `toQueue` alone: the ticket lands `unstarted` in that queue, with no holder.
- `toParty`: the ticket stays `started` for that party and the lease restarts.
  In another queue it lands in that queue's first `started` state.
- `fields` are checked against the target queue (no required keys) and merged
  into the ticket.
- Refused with a result when `hopCount` has reached `maxHops` (`HOP_LIMIT`), or
  when the target (the queue, or the party if `toParty` is set) already gave
  this ticket away twice in its last 50 transitions (`PING_PONG`). The ticket
  then escalates once, if its queue has `escalateTo`. When it does not escalate
  (no `escalateTo`, or already escalated), the refusal is recorded as a
  `guardrail_tripped` transition and the ticket does not change.

**Returns:** `HandoffResult`.

### resolve(ctx, { ticketId, actor, claimSeq, resolution, result?, body?, to?, queue? })

Finish a `started` ticket. `resolution` is `completed`, `failed` or `rejected`.
`result` is checked against the queue's result fields. Required result keys are
enforced only for `completed`. `body` is added as a public message; like `reply`
it counts against `maxMessages` (`MESSAGE_LIMIT`) and the `messagesPerMinute`
rate limit (`RATE_LIMITED`), and a refusal changes nothing, so resolve without a
`body` to finish anyway. `to` picks a `done` state (default: the first).

`completed` clears this ticket from every ticket it blocks. Any other resolution
clears nothing and emits `blocker_failed` to each dependent. After the move, the
reopen window applies: `0` seals now, `null` never seals, otherwise a timer
seals at the end of the window. **Returns:** `MoveResult`.

### reopen(ctx, { ticketId, actor, trusted?, to?, reason? })

Reopen a `done` or `canceled` ticket before it is sealed. The requester, or
`trusted`. The ticket lands `unstarted` (or `to`) with no holder. Resolution,
result and end times are cleared. If it had completed, every ticket it blocks
counts it as open again. The ticket counts against `maxOpenPerRequester` for its
requester again (`TOO_MANY_OPEN`). If it has a due time that has not breached,
the due timer is set again, at the due time or now if that has passed.
**Returns:** `MoveResult`.

### close(ctx, { ticketId, actor })

Host move. Seal a `done` or `canceled` ticket now. Sets `closedAt`. A sealed
ticket takes no more writes (`SEALED`). **Returns:** `MoveResult`.

### cancel(ctx, { ticketId, actor, trusted?, to?, reason? })

Call a ticket off from any category before `done`. The requester, or `trusted`.
No result is written. Lands in the first `canceled` state, or `to`. Tickets it
blocks get `blocker_failed`. **Returns:** `MoveResult`.

### escalate(ctx, { ticketId, actor, claimSeq?, trusted?, reason })

Send a ticket to its queue's `escalateTo`, in any category before `done`. The
holder (with `claimSeq`), or `trusted`. The ticket lands `unstarted` in the
target queue with no holder, its priority number drops by one (floor `0`), and
`escalatedAt` is set. It does not count as a hop and the hop limit does not
apply. Throws `NO_ESCALATION` when the queue has no `escalateTo`. **Returns:**
`MoveResult`.

This call always works. Automatic escalation (the hop limit, the ping-pong
check, the message cap, repeated lease expiry and `escalateOnDue`) happens once
per ticket: when `escalatedAt` is already set, a lease expiry returns the ticket
to the queue it is in (`lease_expired`), a due time only emits `due_breached`,
and a refusal is recorded as `guardrail_tripped`.

### link(ctx, { ticketId, actor, relation, toTicketId?, refKind?, ref?, label? })

Add a link. **Returns:** the link id (`string`). A link that already exists is
returned, not added twice.

| `relation`              | Needs                                | Meaning                                                                                                  |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `blocks`                | `toTicketId`                         | `ticketId` must complete before `toTicketId` can start or go on                                          |
| `duplicates`, `relates` | `toTicketId`                         | A plain edge between two tickets                                                                         |
| `ref`                   | `refKind` and `ref`, no `toTicketId` | A pointer to an outside thing. Use your own `refKind`, such as `label`, `agentThread`, `file` or `cycle` |

A `blocks` link checks the caps (`TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED`) and
walks the chain upstream to refuse a cycle (`CYCLE`, or `GRAPH_TOO_DEEP` past
`maxGraphWalk`). It raises the blocked ticket's `openBlockers` when the blocker
is not completed. A blocker that already ended without completing (`failed`,
`rejected` or `canceled`) throws `INVALID_ARGUMENT`, since it can never clear. A
sealed blocker throws `SEALED` instead, even a completed one.

A link needs a ticket that is not sealed: `link` throws `SEALED` when `ticketId`
is sealed, and for `blocks` also when `toTicketId` is. `open` with `blockedBy`
and `hold` with `blockers` refuse a sealed blocker the same way. A `relates` or
`duplicates` link from an active ticket to a sealed one is allowed.

### unlink(ctx, { linkId })

Remove a link. **Returns:** `null`. Removing a `blocks` link keeps the blocked
ticket's counter exact, and may release it (`unblocked` or `resumed`). Throws
`SEALED` when the link's owner (`ticketId`) is sealed; for a `blocks` link, only
when the blocked ticket is sealed. A sealed blocker's link can still be removed,
so a ticket waiting on a blocker that failed and sealed can be freed. The
retention purge does not go through `unlink`.

### isIn(ticket, queue)

Client only, no call to the component. Narrows a `TicketView` to one queue's
field and result types. Returns true when the ticket is in `queue` and every
declared value fits the definition.

## Result unions

```ts
type ClaimResult =
  | {
      ok: true;
      ticketId: string;
      claimSeq: number;
      state: string;
      leaseExpiresAt?: number;
    }
  | {
      ok: false;
      reason: "TAKEN" | "BLOCKED" | "RESERVED" | "EMPTY" | "NOT_CLAIMABLE";
      ticketId?: string;
    };

type ReplyResult =
  | { ok: true; messageId: string; resumed: boolean; duplicate: boolean }
  | { ok: false; reason: "MESSAGE_LIMIT"; escalated: boolean };

type HandoffResult =
  | { ok: true; queue: string; state: string; claimSeq: number }
  | { ok: false; reason: "HOP_LIMIT" | "PING_PONG"; escalated: boolean };

type MoveResult = {
  queue: string;
  state: string;
  category: Category;
  claimSeq: number;
};
```

| Reason          | Meaning                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| `TAKEN`         | Another party holds the ticket (it is `started` or `waiting`)                            |
| `BLOCKED`       | The ticket has open blockers                                                             |
| `RESERVED`      | The ticket is reserved for another party                                                 |
| `EMPTY`         | "Claim next" found nothing claimable in the queue                                        |
| `NOT_CLAIMABLE` | The ticket is not `unstarted`: it is in `backlog`, `done` or `canceled`                  |
| `MESSAGE_LIMIT` | The ticket has `maxMessages` messages. `escalated` says whether it moved to `escalateTo` |
| `HOP_LIMIT`     | The ticket reached `maxHops`. `escalated` as above                                       |
| `PING_PONG`     | The target already gave this ticket away twice. `escalated` as above                     |

`MoveResult` says where the ticket is after the move. `resolve` returns the
state after any immediate seal.

A refusal that does not escalate writes one `guardrail_tripped` transition, and
one event, with the code and a short text as `reason` and the caller as the
actor. Nothing else on the ticket changes, and `claimSeq` stays. Retries are not
recorded twice: while no other transition happens on the ticket, the same code
is recorded once, so a stuck caller cannot flood the history or push older
handoffs out of the ping-pong window. Refusals that throw (`RATE_LIMITED`,
`TOO_MANY_OPEN`) cannot be recorded: the call rolls back.

## The ticketEvent payload

The component schedules the host's `onEvent` function after every transition
with one `ticketEvent`. Use the exported `ticketEvent` field map as the `args`
of your hook.

| Field          | Type             | Description                                                   |
| -------------- | ---------------- | ------------------------------------------------------------- |
| `ticketId`     | `string`         | The ticket                                                    |
| `seq`          | `number`         | The ticket's transition number. Counts up from 1 without gaps |
| `type`         | `TransitionType` | What happened. See below                                      |
| `queue`        | `string`         | The queue after the move                                      |
| `state`        | `string`         | The state name after the move                                 |
| `category`     | `Category`       | The category after the move                                   |
| `fromQueue`    | `string?`        | The queue before, when the queue changed                      |
| `fromState`    | `string?`        | The state before. Absent on `opened`                          |
| `fromCategory` | `Category?`      | The category before. Absent on `opened`                       |
| `waitingOn`    | `WaitingOn?`     | `requester`, `blockers` or `external`, while waiting          |
| `blocked`      | `boolean`        | True when `openBlockers` is above 0                           |
| `openBlockers` | `number`         | Blockers not completed yet                                    |
| `priority`     | `number`         | 0 (urgent) to 4                                               |
| `requesterRef` | `string`         | The requester                                                 |
| `assigneeRef`  | `string?`        | The assignee: a reservation before start, the holder after    |
| `claimSeq`     | `number`         | The claim number after the move                               |
| `actor`        | `Party`          | Who made the move. `SYSTEM_PARTY` for timers and cascades     |
| `reason`       | `string?`        | The reason given, or one the component wrote                  |
| `at`           | `number`         | Epoch ms                                                      |

The event carries no message bodies and no fields. Call `get` for those.

**Delivery.** The hook is scheduled with a delay of zero, so a hook that throws
cannot roll back the ticket move, and it may see a newer ticket than the one
that caused the event. The guarantee is one event per transition, with a `seq`
that counts that ticket's transitions without gaps. **Delivery order is not
guaranteed: order by `seq`.** Two transitions made in one mutation schedule two
hook runs, and Convex may run them in parallel. On 2026-11-27 the example refund
flow ran on a real local Convex backend. The hook got exactly one event per
transition, `seq` 1 to 7, and they arrived as `opened` (1), `input_requested`
(3), `claimed` (2), `input_provided` (4), `held` (5), `resumed` (6), `resolved`
(7). Under `convex-test`, scheduled functions run one at a time, so tests see
`seq` order. A mount without `onEvent` schedules nothing.

### Transition types

| `type`              | Emitted when                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opened`            | `open`                                                                                                                                                       |
| `moved`             | `move`                                                                                                                                                       |
| `assigned`          | `assign` changed the assignee                                                                                                                                |
| `claimed`           | `claim` won                                                                                                                                                  |
| `released`          | `release`                                                                                                                                                    |
| `lease_expired`     | A lease ran out and the ticket returned to its queue                                                                                                         |
| `handed_off`        | `handoff` succeeded                                                                                                                                          |
| `input_requested`   | `requestInput`                                                                                                                                               |
| `input_provided`    | The requester answered an input request with `reply`                                                                                                         |
| `held`              | `hold`                                                                                                                                                       |
| `resumed`           | `resume`, the last blocker completing, or a blocker ending without completing on a ticket waiting on blockers                                                |
| `unblocked`         | The last open blocker of an `unstarted` or `backlog` ticket completed or was unlinked                                                                        |
| `blocker_failed`    | A blocker of this ticket ended as `failed`, `rejected` or `canceled`. Nothing is cleared                                                                     |
| `resolved`          | `resolve`                                                                                                                                                    |
| `reopened`          | `reopen`                                                                                                                                                     |
| `closed`            | The ticket was sealed: by `close`, by the seal timer, or at once when `reopenWindowMs` is `0`                                                                |
| `canceled`          | `cancel`                                                                                                                                                     |
| `escalated`         | The ticket moved to its `escalateTo` queue                                                                                                                   |
| `due_breached`      | The due time passed on a ticket that was not done or canceled. Emitted once                                                                                  |
| `guardrail_tripped` | A handoff (`HOP_LIMIT`, `PING_PONG`) or a `reply` (`MESSAGE_LIMIT`) was refused and did not escalate. `reason` is the code and a short text. No other change |

## Allowed moves and who may make them

The component checks the caller's relation to the ticket. The host gates
everything else before it calls in.

| Move           | From to                                                                   | Who                                                   |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `open`         | new ticket in `unstarted` (or `backlog` with `to`)                        | Any party the host lets in                            |
| `move`         | within one category, or `backlog` and `unstarted`                         | The holder if held, else the host                     |
| `assign`       | any category before `done`                                                | Host                                                  |
| `claim`        | `unstarted` to `started`                                                  | Any party the host lets in                            |
| `renew`        | `started` to `started`                                                    | Holder                                                |
| `release`      | `started` to `unstarted`                                                  | Holder, or trusted host                               |
| lease expiry   | `started` to `unstarted` (or escalated)                                   | System timer                                          |
| `requestInput` | `started` to `waiting` on the requester                                   | Holder                                                |
| `reply`        | `waiting` on the requester to `started`                                   | Requester. Otherwise it only adds a message           |
| `hold`         | `started` to `waiting` on blockers or external                            | Holder                                                |
| `resume`       | `waiting` to `started`                                                    | Holder, trusted host, or the system when blockers end |
| `handoff`      | `started` to `unstarted` in another queue, or `started` for a named party | Holder                                                |
| `resolve`      | `started` to `done`                                                       | Holder                                                |
| `reopen`       | `done` or `canceled` to `unstarted`, before the seal                      | Requester, or trusted host                            |
| `close`        | seals a `done` or `canceled` ticket                                       | Host, or the system at the window end                 |
| `cancel`       | any category before `done` to `canceled`                                  | Requester, or trusted host                            |
| `escalate`     | any category before `done` to `unstarted` in `escalateTo`                 | Holder, trusted host, or the system                   |

## Errors

Every failure that is not an expected refusal throws a `ConvexError` whose
`data` is `{ code, message, retryAt? }`. `retryAt` (epoch ms) is set on
`RATE_LIMITED`. Use `isTicketsError(error, code?)` to test for one.

```ts
import { isTicketsError } from "@vllnt/convex-tickets";

try {
  await tickets.resolve(ctx, args);
} catch (error) {
  if (isTicketsError(error, "CLAIM_LOST")) return; // someone else holds it now
  throw error;
}
```

`ERROR_CODES` lists every code:

| Code                     | Thrown when                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`       | A bad argument: empty `title`, `priority` not an integer 0 to 4, `claim` with no `ticketId` or `queue`, `handoff` with no target, a holder move without `claimSeq` that is not `trusted`, a malformed `link`, a `blocks` blocker (`open`, `hold`, `link`) that ended without completing, `list` with both `state` and `category`, a bad `search` limit, or a bad `sync` limit, `retentionMs` or hook handle |
| `INVALID_QUEUE`          | `sync` got a bad queue definition (see `sync`)                                                                                                                                                                                                                                                                                                                                                              |
| `STATE_CATEGORY_CHANGED` | `sync` tried to move an existing state to another category                                                                                                                                                                                                                                                                                                                                                  |
| `STATE_IN_USE`           | `sync` tried to drop a state that still has tickets                                                                                                                                                                                                                                                                                                                                                         |
| `FIELD_CHANGED`          | `sync` tried to remove a field, change its type, or remove an enum option                                                                                                                                                                                                                                                                                                                                   |
| `UNKNOWN_QUEUE`          | The queue was never written by `sync`                                                                                                                                                                                                                                                                                                                                                                       |
| `UNKNOWN_STATE`          | A `to` or `move` target is not a state of the queue                                                                                                                                                                                                                                                                                                                                                         |
| `INVALID_TARGET`         | A `to` names a state in the wrong category for the move, a waiting state that does not fit `waitingOn`, or `open` with `to` outside `unstarted` and `backlog`                                                                                                                                                                                                                                               |
| `NO_LANDING_STATE`       | The queue has no state in the category the move needs, such as no waiting state for `requestInput`                                                                                                                                                                                                                                                                                                          |
| `UNKNOWN_FIELD`          | A field or result key the queue does not declare, or a `requestInput` field it does not declare                                                                                                                                                                                                                                                                                                             |
| `INVALID_FIELD`          | A field value of the wrong type, an enum value outside `options`, a non-finite number, or (in the client) a value that is not a string, number, boolean or null                                                                                                                                                                                                                                             |
| `MISSING_FIELD`          | A required field is missing or `null` (at `open`, or in a `completed` result)                                                                                                                                                                                                                                                                                                                               |
| `TOO_MANY_FIELDS`        | A fields or result record has more than `maxFields` keys                                                                                                                                                                                                                                                                                                                                                    |
| `TOO_LONG`               | A string is over its cap: `maxStringChars` for titles, field strings, reasons and link parts, `maxBodyChars` for bodies                                                                                                                                                                                                                                                                                     |
| `FIELDS_NOT_ACCEPTED`    | `reply` carried fields from anyone but the requester answering an input request                                                                                                                                                                                                                                                                                                                             |
| `NOT_FOUND`              | A ticket, parent, blocker or link id does not exist                                                                                                                                                                                                                                                                                                                                                         |
| `WRONG_QUEUE`            | The `queue` argument does not match the ticket's queue                                                                                                                                                                                                                                                                                                                                                      |
| `INVALID_MOVE`           | The ticket is in a category the verb does not accept, or `move` crosses categories                                                                                                                                                                                                                                                                                                                          |
| `SEALED`                 | The ticket is closed and takes no more writes. `link`, `open` (`blockedBy`) and `hold` (`blockers`) also refuse a sealed blocker; `unlink` refuses a link whose owner is closed, and a `blocks` link only when its blocked ticket is closed                                                                                                                                                                 |
| `CLAIM_LOST`             | The `claimSeq` is stale, or the lease of a started ticket expired                                                                                                                                                                                                                                                                                                                                           |
| `NOT_HOLDER`             | The caller is not the holder                                                                                                                                                                                                                                                                                                                                                                                |
| `NOT_REQUESTER`          | `cancel` or `reopen` by someone who is not the requester and not `trusted`                                                                                                                                                                                                                                                                                                                                  |
| `HOLDER_REQUIRED`        | `assign` with `null` on a `started` or `waiting` ticket                                                                                                                                                                                                                                                                                                                                                     |
| `NOT_BLOCKED`            | `hold` on blockers when every blocker is already completed                                                                                                                                                                                                                                                                                                                                                  |
| `NO_ESCALATION`          | `escalate` on a queue with no `escalateTo`                                                                                                                                                                                                                                                                                                                                                                  |
| `CYCLE`                  | A `blocks` link would close a cycle, or a ticket would block itself                                                                                                                                                                                                                                                                                                                                         |
| `GRAPH_TOO_DEEP`         | The upstream walk for the cycle check passed `maxGraphWalk` tickets                                                                                                                                                                                                                                                                                                                                         |
| `TOO_MANY_BLOCKERS`      | A ticket already has `maxBlockers` blockers                                                                                                                                                                                                                                                                                                                                                                 |
| `TOO_MANY_BLOCKED`       | A blocker already blocks `maxBlocked` tickets                                                                                                                                                                                                                                                                                                                                                               |
| `TOO_MANY_OPEN`          | `open` or `reopen` when the requester already has `maxOpenPerRequester` active tickets in the queue                                                                                                                                                                                                                                                                                                         |
| `RATE_LIMITED`           | A party is over `opensPerMinute` (`open`) or `messagesPerMinute` (`reply`, `requestInput`, or `resolve` with a `body`). `retryAt` says when to retry                                                                                                                                                                                                                                                        |
| `MESSAGE_LIMIT`          | `requestInput`, or `resolve` with a `body`, on a ticket that already has `maxMessages` messages. (`reply` returns this as a result)                                                                                                                                                                                                                                                                         |

`TAKEN`, `BLOCKED`, `RESERVED`, `EMPTY`, `NOT_CLAIMABLE`, `HOP_LIMIT` and
`PING_PONG` are result reasons, not error codes.

## Defaults

All default numbers are starting guesses.

```ts
DEFAULT_STATES = [
  { name: "open", category: "unstarted" },
  { name: "working", category: "started" },
  { name: "waiting", category: "waiting" },
  { name: "resolved", category: "done" },
  { name: "canceled", category: "canceled" },
];

DEFAULT_POLICY = {
  leaseMs: 300_000, // 5 minutes
  reopenWindowMs: 604_800_000, // 7 days
  maxHops: 6,
  maxReturns: 3,
  maxMessages: 200,
  maxOpenPerRequester: 50,
};

DEFAULT_LIMITS = {
  maxBodyChars: 20_000,
  maxStringChars: 1_000,
  maxFields: 50,
  maxBlockers: 20,
  maxBlocked: 100,
  maxGraphWalk: 200,
  opensPerMinute: 30,
  messagesPerMinute: 120,
};

LIMIT_CEILINGS = {
  maxBlockers: 20,
  maxBlocked: 100,
  maxGraphWalk: 200,
};
```

`DEFAULT_LIMITS` are mount-wide and set through `new Tickets(..., { limits })`
and `sync`. The three graph limits cannot go above `LIMIT_CEILINGS` (`sync`
throws `INVALID_ARGUMENT`). Every read of blocker links takes up to the ceiling,
so lowering a limit later never hides a link that exists: the lower value only
stops new links past it. Rate limits are token buckets per party with a burst
equal to the rate. `priority` runs from 0 (urgent) to 4 and defaults to 2.
`dueInMs` has no default (no due time), and a ticket's `dueAt` is fixed at open.

## Presets

`@vllnt/convex-tickets/presets`. Each takes `{ fields?, result?, policy? }`.
Policy keys you pass win over the preset's. Each returns settings for
`defineQueue`.

| Preset           | States                                                                                                                                             | Policy it sets                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `agentQueue()`   | the default five                                                                                                                                   | `leaseMs: 300000`                       |
| `deskQueue()`    | `DESK_STATES`: `new` (unstarted), `open` (started), `pending` (waiting on requester), `on_hold` (waiting on external), `solved` (done), `canceled` | `leaseMs: null`                         |
| `projectQueue()` | `PROJECT_STATES`: `backlog`, `todo` (unstarted), `in_progress`, `in_review` (started), `done`, `canceled`                                          | `leaseMs: null`, `reopenWindowMs: null` |

## Agent tools

`ticketTools(tickets, { party, view? })` from `@vllnt/convex-tickets/tools`
returns eight tools, keyed by `TOOL_NAMES`: `open`, `list`, `get`, `claim`,
`reply`, `requestInput`, `handoff`, `resolve`. Each is
`{ name, description, args, handler }`. `args` are Convex validators. `handler`
is `(ctx, args) => Promise<...>` and takes a `RunMutationCtx`. The bound `party`
is added as `actor`. It is never a tool argument. `view` defaults to `"public"`;
`"internal"` lets the tool read internal notes.

| Tool           | Args                                                                                                                                       | Returns                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `open`         | `queue`, `title`, `fields?`, `body?`, `to?`, `priority?`, `subjectRef?`, `parentId?`, `blockedBy?`, `idempotencyKey?`                      | The ticket id                                                                                                        |
| `list`         | `by` (`queue`, `assignee`, `requester`, `subject`, `parent` or `search`), `value`, `queue?`, `state?`, `category?`, `cursor?`, `numItems?` | A page `{ page, isDone, continueCursor }`. `numItems` defaults to 20 and is capped at 100. `search` returns one page |
| `get`          | `ticketId`                                                                                                                                 | `TicketDetail \| null`, with the bound `view`                                                                        |
| `claim`        | `ticketId?`, `queue?`                                                                                                                      | `ClaimResult`                                                                                                        |
| `reply`        | `ticketId`, `body`, `visibility?`, `fields?`, `idempotencyKey?`                                                                            | `ReplyResult`                                                                                                        |
| `requestInput` | `ticketId`, `claimSeq`, `body`, `fields?`                                                                                                  | The `requestInput` result                                                                                            |
| `handoff`      | `ticketId`, `claimSeq`, `toQueue?`, `toParty?`, `reason?`, `fields?`                                                                       | `HandoffResult`                                                                                                      |
| `resolve`      | `ticketId`, `claimSeq`, `resolution`, `result?`, `body?`                                                                                   | `MoveResult`                                                                                                         |

Host moves (`assign`, `close`, the `trusted` flag) are never in the set. `move`,
`hold`, `release`, `renew`, `cancel`, `reopen` and `link` are client methods;
wrap them yourself when an agent needs them.

## Reads

### TicketView

| Field                                                               | Description                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ticketId`, `queue`, `state`, `category`                            | Identity and place                                                     |
| `waitingOn?`                                                        | `requester`, `blockers` or `external`                                  |
| `openBlockers`                                                      | Blockers not completed yet                                             |
| `priority`, `title`, `subjectRef?`, `parentId?`                     | As opened                                                              |
| `requesterRef`, `requesterKind`                                     | The requester                                                          |
| `assigneeRef?`, `assigneeKind?`                                     | A reservation before start, the holder after                           |
| `claimSeq`                                                          | The current claim number                                               |
| `fields`, `schemaVersion`                                           | Typed fields (scalars). `schemaVersion` is the queue's version at open |
| `resolution?`, `result?`                                            | Set when `done`                                                        |
| `dueAt?`, `dueBreachedAt?`                                          | Due time and when it was breached                                      |
| `hopCount`, `messageCount`, `leaseExpiryCount`, `escalatedAt?`      | Guardrail counters                                                     |
| `createdAt`, `updatedAt`, `resolvedAt?`, `canceledAt?`, `closedAt?` | Times. `closedAt` is the seal                                          |

### MessageView

`{ messageId, ticketId, seq, authorRef, authorKind, visibility, kind, body, data?, requestedFields?, createdAt }`.
`kind` is `message`, `input_request` or `system`. `data` holds the fields a
reply supplied.

### LinkView

`{ linkId, ticketId, relation, toTicketId?, refKind?, ref?, label?, createdByRef, createdAt }`.
For `blocks`, `ticketId` is the blocker and `toTicketId` the ticket that waits.

### TransitionView

`{ ticketId, seq, type, fromState?, toState, fromCategory?, toCategory, actorRef, actorKind, fromQueue?, toQueue?, fromAssigneeRef?, toAssigneeRef?, reason?, at }`.
`fromQueue` and `toQueue` are set only when the queue changed; the assignee pair
only when the assignee changed.

## Timers and retention

Each timer is one scheduled function set when its deadline is known. It compares
the value it was scheduled for with the ticket and does nothing if they differ,
so it is safe to run twice.

| Timer        | Set when                                                                                                                                                | When it fires                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lease expiry | A lease starts (claim, assign, a move into `started`, a handoff to a party, or a resume: `resume`, a requester `reply`, or the last blocker completing) | If the claim is unchanged and the lease has run out, the ticket returns to `unstarted` (`lease_expired`). After `maxReturns` expiries, and if the queue has `escalateTo` and the ticket never escalated, it escalates instead. A renewal reschedules |
| Due time     | `open`, when the queue has `dueInMs`; `reopen`, if it has not breached                                                                                  | Emits `due_breached` once on a ticket that is not done or canceled. Escalates when `escalateOnDue` is true and the ticket never escalated                                                                                                            |
| Seal         | A ticket reaches `done` or `canceled` with a reopen window above 0                                                                                      | Seals the ticket (`closed`), unless it was reopened since                                                                                                                                                                                            |
| Retention    | A daily cron (`tickets:purge`)                                                                                                                          | With `retentionMs` set, deletes sealed tickets older than that with their messages, history and links, in batches of 200 rows, rescheduling itself until none is left. Off by default. A queue that never seals is never purged                      |

A lease timer belongs to one lease row: a renewal keeps the row, so its timer
carries on, but a claim, resume or handoff makes a new row and the old timer
ends when it fires. A queue whose `leaseMs` became `null` makes the timer do
nothing.

A queue without a lease sets no lease row and no lease timer. Nothing takes a
ticket back from a holder who went silent there. The due time, escalation and
`assign` are the only backstops.

## Testing

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "@vllnt/convex-tickets/test";
import schema from "./schema";

const t = convexTest(schema, import.meta.glob("./**/*.ts"));
register(t, "tickets"); // the name used in app.use(tickets, { name })
```

`register` also mounts the rate-limiter child as `<name>/rateLimiter`. It needs
`convex-test` and `vitest` in the consuming app. Leases, due times and seals
fire only when you advance fake timers.

## Security model

The component is auth-agnostic. It checks only a party's relation to a ticket:
the holder, the requester and the claim number. It does not know who may use a
queue, and it trusts the `actor` it is given.

Integrators must derive `actor` from their own auth layer (for example
`ctx.auth.getUserIdentity()`) before calling in. They must also gate host moves,
the `trusted` flag and `view: "internal"`. A `claimSeq` stops stale writes from
a former holder; it is not a secret and does not stop a forged one. The
component stores no secrets, does not log, and never executes work.
