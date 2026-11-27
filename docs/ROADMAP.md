# Roadmap: @vllnt/convex-tickets

> Living roadmap, derived from the design in
> [specs/active/2026-11-27-convex-tickets.md](../specs/active/2026-11-27-convex-tickets.md)
> (build order, open decisions and "Gaps against the design"). Dated 2026-11-27.
> Use `CHANGELOG.md`, open issues and active PRs for current release planning.

## Priority Legend

- **GATE** - blocks the stable 0.1.0 release
- **HIGH** - needed to prove the design or to run the first adopter
- **MEDIUM** - quality of life / extensibility
- **LOW** - nice to have, only when a consumer asks

---

## Now: 0.1.0 canary (this PR)

Goal: ship the core and the first layer so the first adopter can run on it.
Published under the `canary` tag only.

| #   | Task                                                                                                                                 | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 0.1 | Core: queues, named states in six categories, typed flat fields and results, claims with an optional lease, assign, thread, links    | Done   |
| 0.2 | Blockers (`blocks` links plus a counter), parent and child, history, escalation, reopen window and seal, retention purge             | Done   |
| 0.3 | Guardrails: hop limit, ping-pong check, message cap, per-requester open cap, per-party rate limits                                   | Done   |
| 0.4 | Scheduled host hook (`ticketEvent`, one event per transition with `seq`)                                                             | Done   |
| 0.5 | Typed client, presets (`agentQueue`, `deskQueue`, `projectQueue`), eight agent tools (`./tools`), `convex-test` helper (`./test`)    | Done   |
| 0.6 | Example app: the refund flow with an agent queue and a human queue, plus desk and project queues, run end to end under `convex-test` | Done   |
| 0.7 | Docs: README, API reference, `llms.txt`, design spec with its gaps                                                                   | Done   |

**Exit criteria:** 100% coverage under `convex-test`, `pnpm test:package`
passes, a canary build is published. Nothing else is promised for 0.1.0.

---

## Next

Order matters. Each phase says what it proves.

### Phase 1: First adopter, then canary

Goal: real tickets opened and resolved by two different parties.

| #   | Task                                                                                                             | Priority | Addresses                              |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| 1.1 | Wire the component into the first adopter (the owner's own agent fleet, board layer)                             | HIGH     | Proof that the board layer works       |
| 1.2 | Publish a canary build and run real work through it                                                              | HIGH     | Proof against real, not scripted, load |
| 1.3 | Fix what the first adopter finds. Record each core change against the two-of-three rule in the design spec       | HIGH     | Scope creep                            |
| 1.4 | Measure "claim next" contention on a busy queue. If it is a problem, document one agent per ticket from the hook | MEDIUM   | Write volume risk                      |

**Exit criteria:** two different parties opened and resolved real tickets
through the canary.

### Phase 2: Desk and projects example apps

Goal: prove "desk and projects need no core change".

| #   | Task                                                                                                                | Priority | Addresses                       |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| 2.1 | A desk example app: the refund with a human queue, reply, reopen window, due time and escalation                    | HIGH     | Gap: queues in one example only |
| 2.2 | A projects example app: the engineering queue with a board screen, blockers, no lease, no seal                      | HIGH     | Gap: queues in one example only |
| 2.3 | Build both with no change to `src/component/`. If one needs a change, apply the core rule and write the result down | GATE     | Foundation claim is unproven    |

**Exit criteria:** both apps run without a core change, or each change is
written down against the rule.

### Phase 3: Live board example

Goal: show the board layer with real agents, not a script.

| #   | Task                                                                                                    | Priority | Addresses                          |
| --- | ------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| 3.1 | Two agents on `@convex-dev/agent` run the refund live, woken by the hook through `@convex-dev/workpool` | MEDIUM   | Gap: the example agent is scripted |
| 3.2 | Serve the agent tools over `@convex-dev/mcp`, with the acting party bound by the host                   | MEDIUM   | Gap: tools are not served over MCP |
| 3.3 | Document the HTTP option gated by [`@vllnt/convex-api-keys`](https://github.com/vllnt/convex-api-keys)  | LOW      | Agents that run outside Convex     |

The component itself will not depend on these packages. They live in the example
and in host code.

### Phase 4: A field-update move

Goal: let a holder edit fields after `open`.

| #   | Task                                                                                                         | Priority | Addresses                                      |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------- |
| 4.1 | A holder move that updates fields, checked against the queue definition, with a history row and a hook event | MEDIUM   | Gap: fields change only through reply, handoff |
| 4.2 | Decide who may call it (holder, requester, trusted host) and write the guard order down                      | MEDIUM   | A project queue editing an estimate needs it   |

Only fields change today through `reply` (the requester answering an input
request) and `handoff`. A project queue that edits an estimate has no way to do
it.

### Phase 5: Ordered hook delivery (only if a consumer needs it)

Goal: give a host events in `seq` order per ticket.

On 2026-11-27 the example refund flow ran on a real local Convex backend. The
hook got one event per transition with `seq` 1 to 7, but they arrived out of
order. Two transitions in one mutation schedule two hook runs, and Convex may
run them in parallel. This is the documented behaviour: the hook is scheduled,
and the host orders by `seq`. `convex-test` runs scheduled functions one at a
time, so tests do not show it.

| #   | Task                                                                                                                                                                | Priority | Addresses                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------- |
| 5.1 | Optional ordered per-ticket delivery: an outbox table written in the same transaction as the transition, and an action dispatcher that delivers rows in `seq` order | LOW      | Hook events can arrive out of `seq` order    |
| 5.2 | Keep the default as it is: scheduled, one event per transition, unordered. The outbox is opt-in                                                                     | LOW      | A hook that throws must not roll back a move |

Not started. A host that only needs the latest state can already call `get`, or
sort the events it keeps by `seq`.

### Phase 6: React entry (last)

Goal: reactive display surfaces for a ticket list and a thread.

| #   | Task                                                              | Priority | Addresses                            |
| --- | ----------------------------------------------------------------- | -------- | ------------------------------------ |
| 6.1 | An optional `./react` entry: `useQueue`, `useTicket`, `useThread` | LOW      | Gap: the React entry is out of scope |

It comes last, after a consumer has a screen that needs it.

---

## Gate to stable 0.1.0

```
canary ──> first adopter runs it ──> second backend, different layer,
                                     core unchanged ──> stable 0.1.0
```

The stable 0.1.0 release waits until a second, different backend runs the core
unchanged on a different layer (the desk or the projects layer). Until then
every build is a canary.

### Stop rule

No second consumer is named today (Rule of Three). The override is recorded in
the design spec. If no second backend runs the core on a different layer by
**2027-02-27** (one quarter after 2026-11-27), move the code into the first
adopter and archive this repository.

---

## Recurring

| Task                                                                                                                                                                                           | When                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Re-run the overlap check: npm names and the Convex components directory. If `@convex-dev/agent` gains assignment, status or handoff, narrow the core to the queue and typed data, or retire it | Before each minor release    |
| Re-read the default numbers (`DEFAULT_POLICY`, `DEFAULT_LIMITS`). They are starting guesses, so change them with evidence from the first adopter                                               | After the first adopter runs |
| Check that every feature in the core still serves at least two of the three layers                                                                                                             | On each core change          |

## Decided out for now

These were judged against the two-of-three rule in the design and stay out. Each
has a way to build it in host code.

| Item                                                                   | Where it goes instead                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A general key-value or agent data store                                | A parent ticket's fields first. A separate proposal if that proves too small        |
| A sortable rank for manual order                                       | A host table keyed by ticket id. Revisit when the projects layer has a consumer     |
| A CLI                                                                  | The host serves the tools over MCP or HTTP                                          |
| Running agents, retries, sequencing work                               | `@convex-dev/agent`, `@convex-dev/workflow`, `@convex-dev/workpool`                 |
| Channels, email or chat intake, canned replies, a business-hours clock | The desk layer in host code                                                         |
| Projects, cycles, saved views, roll-ups                                | The projects layer in host tables (a project is a parent ticket, a cycle is a link) |
| Nested or list-valued fields                                           | A file or host table, with a link on the ticket                                     |
| Creating queues from an admin screen at runtime                        | Queues are defined in code and written by `sync`                                    |

## Milestone Summary

```
0.1.0-canary   Core + board layer + presets + tools + example   (this PR)
later canaries First adopter, desk and projects examples, live board example,
               field-update move, optional ordered delivery, React entry
0.1.0          Only after a second backend runs the core unchanged on a
               different layer (stop rule: 2027-02-27)
```

## Status

- [x] 0.1.0 canary built (2026-11-27): this PR
- [ ] First adopter runs on a canary build
- [ ] Desk and projects example apps
- [ ] Live board example
- [ ] Stable 0.1.0 (gated, see above)
