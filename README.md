<!-- Badges -->

[![Convex Component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm version](https://img.shields.io/npm/v/@vllnt/convex-tickets.svg)](https://www.npmjs.com/package/@vllnt/convex-tickets)
[![CI](https://github.com/vllnt/convex-tickets/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-tickets/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@vllnt/convex-tickets.svg)](./LICENSE)

# @vllnt/convex-tickets

A [Convex component](https://docs.convex.dev/components) that gives any Convex
backend work items that humans and AI agents open, claim, discuss, hand off and
resolve. One core, three thin layers: an agent board, a support desk and project
tracking.

A work item (called a ticket in the code) is one unit of work passed between
parties. It has a queue, a state, a requester, at most one holder, typed fields
and a history. This component stores that record and enforces the rules. It does
not run agents, call an LLM or execute any work. Your app decides who may do
what and starts the agents.

> **Canary only.** 0.1.0 is for the `canary` dist-tag and is not published yet.
> Stable 0.1.0 waits until a second, different backend runs the core unchanged
> on a different layer. See [Status](#status).

```ts
const tickets = new Tickets(components.tickets, { queues: { billing } });

const ticketId = await tickets.open(ctx, {
  queue: "billing",
  actor: support,
  title: "Refund for a double charge",
  fields: { amount: 49, currency: "EUR" },
});
const claim = await tickets.claim(ctx, { ticketId, actor: billingAgent });
if (claim.ok) {
  await tickets.resolve(ctx, {
    ticketId,
    actor: billingAgent,
    claimSeq: claim.claimSeq,
    resolution: "completed",
    result: { refunded: true, refundId: "re_301" },
  });
}
```

## Features

- **One record for all work** — queue, named states, requester, holder, typed
  fields, typed result, thread, links and history.
- **Six fixed categories, your own state names** — each queue names its states
  (Backlog, In review, Pending) and maps each to one category. The rules read
  the category and ignore the name.
- **Claims that one caller wins** — `claim` is one transaction. The loser gets a
  result (`TAKEN`), not an error. An optional lease returns the ticket to the
  queue when the holder goes silent. A claim number rejects late writes from a
  former holder.
- **Ask, wait, resume** — the holder asks the requester for fields and the
  ticket waits. The requester's reply writes the fields and resumes the work.
- **Blockers** — a ticket can wait on up to 20 others. "Claim next" skips
  blocked tickets. Only a blocker that completes clears the wait.
- **Handoff with guardrails** — hop limit, ping-pong check, message cap, rate
  limits, open caps and crash-loop escalation.
- **Typed end to end** — compile-time types for queue names, state names, fields
  and results. The component checks every write again at runtime.
- **Host hook** — one scheduled event per transition, so your app can wake an
  agent or notify a person.
- **Eight agent tools** — open, list, get, claim, reply, requestInput, handoff,
  resolve. The host binds the acting party; a model cannot pick it.
- **Presets** — `agentQueue`, `deskQueue` and `projectQueue` give each layer a
  starting point.
- **Timers and retention** — due time with optional escalation, a seal at the
  end of the reopen window, and an optional purge of sealed tickets.

## Installation

Requires `convex@^1.45.0`.

```bash
npm install convex @vllnt/convex-tickets@canary
```

0.1.0 ships as a canary only. Pin the resolved version for reproducible
installs.

Register in your `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import tickets from "@vllnt/convex-tickets/convex.config";

const app = defineApp();
app.use(tickets);
export default app;
```

The component mounts its own child, `@convex-dev/rate-limiter`. You do not
register it.

## For coding agents

The npm package bundles its docs at `node_modules/@vllnt/convex-tickets/`:
`docs/API.md`, `CHANGELOG.md`, `llms.txt` and the TypeScript source in `src/`.
They match the installed version. Read them before writing code against this
package.

## Words used here

| Word               | Meaning                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Party              | Anyone who acts on a ticket: `{ ref, kind }`. `ref` is an opaque string. `kind` is `human`, `agent` or `system`, a label the component never branches on.       |
| Queue              | A named place where work lands. It declares its fields, result fields, states and policy. You define queues in code and write them with `sync`.                 |
| State and category | A state is a name a queue gives to one step. A category is one of six fixed groups. Every state belongs to one category.                                        |
| Claim              | Taking a ticket so you alone hold it.                                                                                                                           |
| Lease              | A time limit on a claim. If the holder stops renewing, the ticket returns to the queue. A queue can turn it off (`leaseMs: null`) for people who hold for days. |
| Fence (`claimSeq`) | A number that rises each time the holder changes. A write that carries an old number is refused with `CLAIM_LOST`.                                              |
| Blocker            | A ticket that must complete before another one can start or go on.                                                                                              |
| Handoff            | Passing a ticket to another queue or a named party. Each handoff counts as one hop.                                                                             |
| Result             | The typed outcome written when a ticket resolves. The requester reads it as data.                                                                               |
| Seal (`closedAt`)  | A one-way latch on a done or canceled ticket. A sealed ticket takes no more writes.                                                                             |
| Transition         | One row of history: what changed, who did it and when.                                                                                                          |

## Usage

Define queues in a host file, mount the client and write the definitions once
per deploy:

```ts
// convex/tickets.ts
import { Tickets, defineQueue } from "@vllnt/convex-tickets";
import { agentQueue, deskQueue } from "@vllnt/convex-tickets/presets";
import { components, internal } from "./_generated/api";

export const tickets = new Tickets(components.tickets, {
  queues: {
    // Agent queue: default five states, 5-minute lease.
    billing: defineQueue(
      agentQueue({
        fields: {
          amount: { type: "number", required: true },
          currency: { type: "enum", options: ["EUR", "USD"], required: true },
          orderId: { type: "string" }, // may arrive later
        },
        result: {
          refunded: { type: "boolean", required: true },
          refundId: { type: "string" },
        },
        policy: { dueInMs: 60 * 60_000, escalateTo: "billing-humans" },
      }),
    ),
    // People approve here. Lease off: an approver may hold a ticket for a day.
    approvals: defineQueue({
      fields: { amount: { type: "number", required: true } },
      result: { approved: { type: "boolean", required: true } },
      policy: { leaseMs: null },
    }),
    // Desk preset: New, Open, Pending, On hold, Solved, Canceled.
    "billing-humans": defineQueue(deskQueue()),
  },
  onEvent: internal.ticketHooks.onEvent, // optional, see "The host hook"
});

// convex/sync.ts: run once per deploy.
export const syncTickets = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await tickets.sync(ctx);
    return null;
  },
});
```

`sync` is additive. A state's category cannot change, a state that still has
tickets cannot be dropped, and a field cannot be removed or change type.

### The refund example

A customer writes in about a double charge. A support agent opens a ticket in
`billing`. A billing agent claims it and needs the order number, so it asks the
requester. A human approves the refund. The ticket resolves with a result the
support agent reads as data.

```ts
const support = { ref: "agent:support", kind: "agent" } as const;
const billingAgent = { ref: "agent:billing", kind: "agent" } as const;
const approver = { ref: "user:approver", kind: "human" } as const;

// 1. Support opens. `fields` is type-checked against the billing queue.
const ticketId = await tickets.open(ctx, {
  queue: "billing",
  actor: support,
  title: "Refund for a double charge",
  subjectRef: "customer:8841",
  fields: { amount: 49, currency: "EUR" },
  idempotencyKey: "refund:conv_7f3", // a retry returns the same ticket
});

// 2. Billing claims. One transaction, so only one caller gets ok: true.
const claim = await tickets.claim(ctx, { ticketId, actor: billingAgent });
if (!claim.ok) return; // claim.reason: "TAKEN" | "BLOCKED" | "RESERVED" | ...

// 3. Billing needs one fact. The ticket waits on the requester.
await tickets.requestInput(ctx, {
  ticketId,
  actor: billingAgent,
  claimSeq: claim.claimSeq,
  body: "Which order was charged twice?",
  fields: ["orderId"],
});

// 4. Support answers. The value lands on the ticket as a typed field and the
//    ticket returns to work.
await tickets.reply(ctx, {
  ticketId,
  actor: support,
  body: "Order A-1042.",
  fields: { orderId: "A-1042" },
});

// 5. Billing asks a human. The child ticket blocks the parent.
const childId = await tickets.open(ctx, {
  queue: "approvals",
  actor: billingAgent,
  title: "Approve a refund",
  parentId: ticketId,
  fields: { amount: 49 },
});
await tickets.hold(ctx, {
  ticketId,
  actor: billingAgent,
  claimSeq: claim.claimSeq,
  blockers: [childId],
});

// 6. The approver claims and resolves the child. The parent resumes by itself.
const approval = await tickets.claim(ctx, {
  ticketId: childId,
  actor: approver,
});
if (approval.ok) {
  await tickets.resolve(ctx, {
    ticketId: childId,
    actor: approver,
    claimSeq: approval.claimSeq,
    resolution: "completed",
    result: { approved: true },
  });
}

// 7. Billing resolves with a typed result.
await tickets.resolve(ctx, {
  ticketId,
  actor: billingAgent,
  claimSeq: claim.claimSeq,
  resolution: "completed",
  result: { refunded: true, refundId: "re_301" },
  body: "Refunded to the original card.",
});

// 8. Support reads the outcome as data.
const detail = await tickets.get(ctx, { ticketId });
if (detail && tickets.isIn(detail.ticket, "billing")) {
  detail.ticket.result?.refunded; // boolean | null | undefined
}
```

The same flow runs end to end in
[the example app](https://github.com/vllnt/convex-tickets/blob/main/example/convex/example.ts)
and its
[test](https://github.com/vllnt/convex-tickets/blob/main/example/convex/example.test.ts).
The billing agent there is scripted and woken by the hook. A real app runs an
LLM at that point.

## The status model

Every state belongs to one of six categories. The component's rules read the
category only.

```
Main path:   backlog -> unstarted -> started -> done
Pause:       started <-> waiting
Exit:        any category before done -> canceled
```

| Category    | Rule only it has                                                                   | Default state |
| ----------- | ---------------------------------------------------------------------------------- | ------------- |
| `backlog`   | "Claim next" never returns it. Someone must accept it first. Optional.             | none          |
| `unstarted` | Claimable, unless a blocker is open or it is reserved for another party.           | `open`        |
| `started`   | Must have a holder. The lease runs here.                                           | `working`     |
| `waiting`   | Keeps the holder, stops the lease. `waitingOn` says what ends the wait. Optional.  | `waiting`     |
| `done`      | Needs a resolution and a result that fits the queue. Can be reopened until sealed. | `resolved`    |
| `canceled`  | No result. Never clears a blocker.                                                 | `canceled`    |

A queue that declares no states gets the five defaults. A queue that declares
its own must cover `unstarted`, `started`, `done` and `canceled`. The first
state declared in a category is where a verb lands. Any verb takes an optional
`to` that names another state of the right category.

`waitingOn` is an attribute, not a category: `requester` (a reply ends it),
`blockers` (the last blocker completing ends it) or `external` (only `resume`
ends it).

## One core, three layers

A layer is queue settings plus host code. It calls the client class and cannot
read the component's tables.

| Layer    | Preset           | States                                                | Lease | Sealed after     |
| -------- | ---------------- | ----------------------------------------------------- | ----- | ---------------- |
| Board    | `agentQueue()`   | the default five                                      | 5 min | 7 days (default) |
| Desk     | `deskQueue()`    | New, Open, Pending, On hold, Solved, Canceled         | off   | 7 days (default) |
| Projects | `projectQueue()` | Backlog, Todo, In progress, In review, Done, Canceled | off   | never (`null`)   |

Every preset takes `{ fields, result, policy }`. Policy keys you pass win over
the preset's. A preset is a plain function that returns queue settings, so you
can write your own. Presets live in `@vllnt/convex-tickets/presets`.

## Guardrails

Agents write faster than people and do not get bored. Each limit is a queue
policy value or a mount limit with a default. All default numbers are starting
guesses.

| Guardrail                  | Default                          | When it trips                                                                                            |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Hop limit                  | 6 handoffs per ticket            | `handoff` returns `HOP_LIMIT` and the ticket escalates.                                                  |
| Ping-pong                  | target gave it away twice        | `handoff` returns `PING_PONG` and the ticket escalates.                                                  |
| Message cap                | 200 messages per ticket          | `reply` returns `MESSAGE_LIMIT` and the ticket escalates. `requestInput` throws it.                      |
| Rate limit per party       | 30 opens, 120 replies per minute | `RATE_LIMITED` with a `retryAt` time.                                                                    |
| Open tickets per requester | 50 per queue                     | `TOO_MANY_OPEN`.                                                                                         |
| Blockers                   | 20 per ticket, 100 blocked each  | `TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED`. A link that closes a cycle gets `CYCLE`.                        |
| Crash loop                 | 3 lease expiries                 | The ticket escalates instead of returning to the queue. Needs `escalateTo`.                              |
| Due time                   | off                              | Emits `due_breached` once. Escalates when `escalateOnDue` is set.                                        |
| Stale holder               | always on                        | A write with an old `claimSeq` gets `CLAIM_LOST`.                                                        |
| Visibility                 | public view                      | Reads return public messages. Internal notes need `view: "internal"`, which only trusted host code sets. |
| Idempotency                | optional key                     | A repeat `open` or `reply` returns the first id and writes nothing.                                      |

Escalation sends the ticket to the queue named in `escalateTo` and raises its
priority one step. The component does not measure confidence: an agent that is
unsure calls `handoff` to that queue with a reason.

## Agent tools

`@vllnt/convex-tickets/tools` exports `ticketTools(tickets, { party, view? })`.
It returns eight tool definitions, each with a name, a description for the
model, Convex argument validators and a handler. Adapt them to your agent
framework or to an MCP server.

```ts
import { ticketTools } from "@vllnt/convex-tickets/tools";

const tools = ticketTools(tickets, {
  party: { ref: "agent:billing", kind: "agent" },
});
const claim = await tools.claim.handler(ctx, { queue: "billing" });
```

The party is bound by the host and is never a tool argument. Host moves
(`assign`, `close`, the `trusted` flag) are not in the set. `move`, `hold`,
`release`, `renew`, `cancel`, `reopen` and `link` exist on the client class and
stay out of the default tools. Add them when an agent needs them.

Serving the tools to an agent that runs outside Convex is the host's job: use
`@convex-dev/mcp`, or HTTP actions gated by
[`@vllnt/convex-api-keys`](https://github.com/vllnt/convex-api-keys). This
package ships no CLI.

## The host hook

Set `onEvent` to an internal mutation or action that takes the exported
`ticketEvent` validator. The component schedules it after every transition. The
event carries ids, type, queue, state, category, actor and `seq`. It carries no
message bodies and no fields: call `get` for those.

```ts
// convex/ticketHooks.ts
import { ticketEvent } from "@vllnt/convex-tickets";

export const onEvent = internalMutation({
  args: ticketEvent,
  returns: v.null(),
  handler: async (ctx, e) => {
    // New, returned or unblocked billing work: start one agent run.
    if (e.queue === "billing" && e.category === "unstarted" && !e.blocked) {
      await ctx.scheduler.runAfter(0, internal.agents.runBilling, {
        ticketId: e.ticketId,
      });
    }
    return null;
  },
});
```

The hook is scheduled, not called inline. A hook that throws cannot roll back
the ticket move. The cost is that the hook runs a moment later and may see a
newer ticket. Branch on `e.category`, never on a state name, so one hook serves
every queue.

**Delivery order is not guaranteed. Order by `seq`.** The guarantee is one event
per transition, and `seq` counts that ticket's transitions without gaps. Two
transitions made in one mutation schedule two hook runs, and Convex may run
those in parallel. On 2026-11-27 the example refund flow ran on a real local
Convex backend. The hook got exactly one event per transition, `seq` 1 to 7 with
no gap, and they arrived as 1, 3, 2, 4, 5, 6, 7. Under `convex-test`, scheduled
functions run one at a time, so tests see `seq` order. If your host needs
ordered delivery per ticket, sort by `seq` in the hook, or see the optional
ordered delivery item in the
[roadmap](https://github.com/vllnt/convex-tickets/blob/main/docs/ROADMAP.md).

## API Reference

| Method                                                    | Ctx      | Description                                                     |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `sync(ctx)`                                               | mutation | Write queues, states, field types, limits and the hook handle   |
| `open(ctx, { queue, actor, title, ... })`                 | mutation | Open a ticket. A repeated idempotency key returns the first id  |
| `claim(ctx, { actor, ticketId? \| queue? })`              | mutation | Take a ticket, or the next claimable one. Losing is a result    |
| `renew(ctx, { ticketId, actor, claimSeq })`               | mutation | Extend the holder's lease                                       |
| `release(ctx, { ticketId, actor, claimSeq, ... })`        | mutation | Give a started ticket back to its queue                         |
| `assign(ctx, { ticketId, actor, assignee })`              | mutation | Host move. Reserve a ticket, or replace the holder              |
| `move(ctx, { ticketId, actor, to, ... })`                 | mutation | Change state inside one category, or backlog to unstarted       |
| `requestInput(ctx, { ticketId, actor, claimSeq, body })`  | mutation | Ask the requester for fields. The ticket waits                  |
| `reply(ctx, { ticketId, actor, body, ... })`              | mutation | Add a message. The requester answering an input request resumes |
| `hold(ctx, { ticketId, actor, claimSeq, ... })`           | mutation | Wait on blockers or on something external                       |
| `resume(ctx, { ticketId, actor, ... })`                   | mutation | Return a waiting ticket to work                                 |
| `handoff(ctx, { ticketId, actor, claimSeq, ... })`        | mutation | Pass to another queue or party. Counts a hop                    |
| `resolve(ctx, { ticketId, actor, claimSeq, resolution })` | mutation | Finish with a resolution and a typed result                     |
| `reopen(ctx, { ticketId, actor })`                        | mutation | Reopen a done or canceled ticket before the seal                |
| `close(ctx, { ticketId, actor })`                         | mutation | Host move. Seal a done or canceled ticket now                   |
| `cancel(ctx, { ticketId, actor })`                        | mutation | Call a ticket off. No result                                    |
| `escalate(ctx, { ticketId, actor, reason })`              | mutation | Send to the queue's `escalateTo`                                |
| `link(ctx, { ticketId, actor, relation, ... })`           | mutation | Add a `blocks`, `duplicates`, `relates` or `ref` link           |
| `unlink(ctx, { linkId })`                                 | mutation | Remove a link                                                   |
| `get(ctx, { ticketId, view? })`                           | query    | One ticket with lease expiry, links, blockers, recent messages  |
| `list(ctx, { filter, paginationOpts })`                   | query    | Page by queue, assignee, requester, subject or parent           |
| `search(ctx, { text, ... })`                              | query    | Full-text search over titles                                    |
| `listMessages(ctx, { ticketId, view?, paginationOpts })`  | query    | Page through the thread                                         |
| `listTransitions(ctx, { ticketId, paginationOpts })`      | query    | Page through the history                                        |
| `listByRef(ctx, { refKind, ref, paginationOpts })`        | query    | Every link to one outside thing, such as a label                |
| `getQueue(ctx, { name })`                                 | query    | The stored definition of one queue                              |
| `isIn(ticket, queue)`                                     | client   | Narrow a ticket to one queue's field and result types           |

Full reference: [docs/API.md](docs/API.md).

## Security and trust

The component is auth-agnostic. It cannot know whether a caller may use a queue.
It checks only a party's relation to a ticket: is this party the holder, is it
the requester, does its claim number still match. The host does the rest.

- Derive `actor` from your own auth layer. The component trusts the `ref` it is
  given. A compromised host can pass any party.
- Gate every host move yourself: `assign`, `close`, and the `trusted` flag on
  `release`, `resume`, `reopen`, `cancel`, `escalate` and `move`. Never expose
  them as agent tools.
- Gate `view: "internal"` yourself. Internal notes are returned whenever the
  caller asks for them.
- A `claimSeq` is not a secret. It stops stale writes, not forged ones.

## Testing your app

`@vllnt/convex-tickets/test` exports `register(t, name = "tickets")` to mount
the component, and its rate-limiter child, in a `convex-test` instance. It needs
`convex-test`, `vitest` (with Vite's `import.meta.glob`) installed in the
consuming app:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "@vllnt/convex-tickets/test";
import schema from "./schema";

const t = convexTest(schema, import.meta.glob("./**/*.ts"));
register(t, "tickets");
```

Timers (leases, due times, seals) fire only when you advance fake timers. The
[example tests](https://github.com/vllnt/convex-tickets/blob/main/example/convex/harness.helper.ts)
show a setup with `vi.useFakeTimers()` and a helper that runs scheduled hooks.

## Dependencies

Used:

- `@convex-dev/rate-limiter` — child component for the per-party open and reply
  limits.
- `@vllnt/eslint-config` — lint rules (dev).
- `@vllnt/typescript` — tsconfig base (dev).

Not used, on purpose:

- `@vllnt/logger` — the component does not log. History and the hook replace
  logs.
- `@vllnt/testing` — a Playwright E2E kit. It does not fit `convex-test`.
- `@vllnt/convex-helpers` — nothing it offers is needed.
- `@convex-dev/workpool`, `@convex-dev/agent`, `@convex-dev/mcp` — the example
  agent is scripted. Your host may add them: workpool to cap agent runs, agent
  for the LLM and its chat thread, mcp to serve the tools.

## Status

0.1.0 is a canary. The design asks for a second consumer before building, and
none is named. The decision on 2026-11-27: build for the first adopter (an agent
fleet on the board layer), publish canary only, and hold stable 0.1.0 until a
second, different backend runs the core unchanged on a different layer (desk or
projects). If none does within one quarter, by 2027-02-27, the code moves into
the first adopter and this repository is archived.

What 0.1.0 does not do, and where it is tracked:

- Desk and projects are queues in the one example app plus tests, not separate
  example apps.
- The example agent is scripted, not a live LLM. No workpool. The tools are not
  served over `@convex-dev/mcp`.
- No move edits fields after open, except `reply` and `handoff`.
- No React entry, no CLI, no manual rank, no general agent data store.

See the
[roadmap](https://github.com/vllnt/convex-tickets/blob/main/docs/ROADMAP.md) and
the
[design spec](https://github.com/vllnt/convex-tickets/blob/main/specs/active/2026-11-27-convex-tickets.md).

## Related packages

- [`@vllnt/convex-api-keys`](https://github.com/vllnt/convex-api-keys) — API
  keys with rotation and revocation. Use it to let an agent outside Convex call
  the ticket tools over HTTP.
- [`@vllnt/convex-permissions`](https://www.npmjs.com/package/@vllnt/convex-permissions)
  — role-based access control. Use it to decide who may see, claim or assign in
  a queue before you call this component.

## Contributing

See
[CONTRIBUTING.md](https://github.com/vllnt/convex-tickets/blob/main/CONTRIBUTING.md)
for development setup, testing, and PR guidelines.

## Author

Built by [bntvllnt](https://github.com/bntvllnt) ·
[bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).

---

Part of vllnt oss: https://oss.vllnt.com
