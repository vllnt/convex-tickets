import { createFunctionHandle } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType, PaginationOptions } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { DEFAULT_POLICY, DEFAULT_STATES, ticketsError } from "../shared.js";
import type { Category, Limits, Party, Resolution, Scalar, TicketEvent, Visibility } from "../shared.js";
import type {
  AnyQueue,
  FieldsArg,
  FieldsOf,
  FieldsSpec,
  PartialFieldValues,
  PolicyInput,
  QueueDefinition,
  QueueMap,
  ResultOf,
  RunMutationCtx,
  RunQueryCtx,
  StateName,
  StatesSpec,
} from "./types.js";

export {
  CATEGORIES,
  DEFAULT_LIMITS,
  DEFAULT_POLICY,
  DEFAULT_STATES,
  ERROR_CODES,
  LIMIT_CEILINGS,
  SYSTEM_PARTY,
  TRANSITION_TYPES,
  isTicketsError,
  partyValidator,
  scalarRecordValidator,
  scalarValidator,
  ticketEvent,
  ticketEventValidator,
} from "../shared.js";
export type {
  Category,
  Limits,
  Party,
  PartyKind,
  Resolution,
  Scalar,
  ScalarRecord,
  TicketEvent,
  TicketsErrorCode,
  TicketsErrorData,
  TransitionType,
  Visibility,
  WaitingOn,
} from "../shared.js";
export type {
  AnyQueue,
  FieldSpec,
  FieldValues,
  FieldsSpec,
  PartialFieldValues,
  PolicyInput,
  QueueDefinition,
  QueueMap,
  RunMutationCtx,
  RunQueryCtx,
  StateName,
  StateSpec,
  StatesSpec,
} from "./types.js";

type Api = ComponentApi;
type M = Api["mutations"];
type Qs = Api["queries"];

/** One ticket as every read returns it. */
export type TicketView = NonNullable<FunctionReturnType<Qs["get"]>>["ticket"];
/** `get`'s result: the ticket, lease expiry, links, blockers and recent messages. */
export type TicketDetail = NonNullable<FunctionReturnType<Qs["get"]>>;
/** The outcome of `claim`. Losing is a result: `TAKEN`, `BLOCKED`, `RESERVED`, `EMPTY` or `NOT_CLAIMABLE`. */
export type ClaimResult = FunctionReturnType<M["claim"]>;
/** The outcome of `reply`. `MESSAGE_LIMIT` is a result, and may have escalated the ticket. */
export type ReplyResult = FunctionReturnType<M["reply"]>;
/** The outcome of `handoff`. `HOP_LIMIT` and `PING_PONG` are results, and may have escalated the ticket. */
export type HandoffResult = FunctionReturnType<M["handoff"]>;
/** Where a move left the ticket. */
export type MoveResult = FunctionReturnType<M["move"]>;
/** What `list` can filter by. Each filter reads one index range. */
export type ListFilter = FunctionArgs<Qs["list"]>["filter"];

/** A ticket whose fields and result are typed for queue `D`. */
export type TypedTicket<D extends AnyQueue> = Omit<TicketView, "fields" | "result"> & {
  fields: PartialFieldValues<FieldsOf<D>>;
  result?: PartialFieldValues<ResultOf<D>>;
};

/** The host function `onEvent` points at: a mutation or action taking `ticketEvent`. */
export type EventHandler = FunctionReference<"mutation" | "action", "internal", TicketEvent>;

/** Options for a `Tickets` instance. */
export interface TicketsOptions<Q extends QueueMap> {
  /** Every queue of this mount, by name. */
  queues: Q;
  /** Scheduled after every transition with a `ticketEvent`. */
  onEvent?: EventHandler;
  /** Mount-wide limits; see `DEFAULT_LIMITS`. */
  limits?: Partial<Limits>;
  /** Purge sealed tickets this long after they were closed. Off by default. */
  retentionMs?: number;
}

/**
 * Define a queue. Keeps state names and field types as literal types so the
 * client can check them at compile time. A queue with no states gets the
 * default five: open, working, waiting, resolved, canceled.
 *
 * @param definition - States, fields, result fields and policy.
 * @returns The same definition, typed.
 * @example
 * const billing = defineQueue({
 *   fields: { amount: { type: "number", required: true } },
 *   result: { refunded: { type: "boolean", required: true } },
 *   policy: { leaseMs: 5 * 60_000 },
 * });
 */
export function defineQueue<
  const S extends StatesSpec | undefined = undefined,
  const F extends FieldsSpec = Record<never, never>,
  const R extends FieldsSpec = Record<never, never>,
>(definition: { states?: S; fields?: F; result?: R; policy?: PolicyInput }): NoInfer<QueueDefinition<S, F, R>> {
  return definition;
}

function toFieldDefs(fields: FieldsSpec | undefined) {
  return Object.entries(fields ?? {}).map(([key, spec]) => ({
    key,
    type: spec.type,
    required: spec.required === true,
    options: spec.type === "enum" ? [...spec.options] : undefined,
  }));
}

/**
 * Turn a typed queue definition into the plain data `sync` stores.
 *
 * @param name - The queue name.
 * @param definition - The queue definition.
 * @returns The definition with defaults applied.
 * @throws `INVALID_QUEUE` when `states` is an array instead of a record.
 */
export function toQueueDef(name: string, definition: AnyQueue): FunctionArgs<Api["mutations"]["sync"]>["queues"][number] {
  if (Array.isArray(definition.states)) {
    throw ticketsError("INVALID_QUEUE", `queue "${name}": states is a record of state name to { category }, not an array`);
  }
  const states = definition.states
    ? Object.entries(definition.states).map(([state, spec]) => ({ name: state, category: spec.category, on: spec.on }))
    : DEFAULT_STATES.map((s) => ({ name: s.name, category: s.category }));
  const policy = definition.policy ?? {};
  return {
    name,
    states,
    fields: toFieldDefs(definition.fields),
    resultFields: toFieldDefs(definition.result),
    policy: {
      leaseMs: policy.leaseMs === undefined ? DEFAULT_POLICY.leaseMs : policy.leaseMs,
      dueInMs: policy.dueInMs,
      reopenWindowMs: policy.reopenWindowMs === undefined ? DEFAULT_POLICY.reopenWindowMs : policy.reopenWindowMs,
      maxHops: policy.maxHops ?? DEFAULT_POLICY.maxHops,
      maxReturns: policy.maxReturns ?? DEFAULT_POLICY.maxReturns,
      maxMessages: policy.maxMessages ?? DEFAULT_POLICY.maxMessages,
      maxOpenPerRequester: policy.maxOpenPerRequester ?? DEFAULT_POLICY.maxOpenPerRequester,
      escalateTo: policy.escalateTo,
      escalateOnDue: policy.escalateOnDue,
    },
  };
}

function valueFits(spec: FieldsSpec[string] | undefined, value: Scalar | undefined): boolean {
  if (value === undefined || value === null || spec === undefined) return true;
  if (spec.type === "enum") return typeof value === "string" && spec.options.includes(value);
  return typeof value === spec.type;
}

function isScalar(value: unknown): value is Scalar {
  if (typeof value === "number") return Number.isFinite(value);
  return value === null || typeof value === "string" || typeof value === "boolean";
}

/**
 * Copy typed field values into the plain scalar record the component takes, dropping unset keys.
 *
 * @param input - Typed field or result values.
 * @returns A scalar record, or undefined when nothing was given.
 * @throws `INVALID_FIELD` for a value that is not a string, a finite number, a boolean or null.
 */
export function toValues(input: object | undefined): Record<string, Scalar> | undefined {
  if (input === undefined) return undefined;
  const values: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!isScalar(value)) {
      throw ticketsError("INVALID_FIELD", `${key} must be a string, a finite number, a boolean or null`);
    }
    values[key] = value;
  }
  return values;
}

type QueueName<Q extends QueueMap> = keyof Q & string;
type Holder = { ticketId: string; actor: Party; claimSeq: number };
type HostVouched = { ticketId: string; actor: Party; claimSeq?: number; trusted?: boolean };

/**
 * The typed client for one mount of the tickets component. Generic over the
 * host's queue definitions: field values, result values and state names are
 * checked at compile time, and checked again by the component at runtime.
 *
 * "Host" moves (`assign`, `close`, and the `trusted` flag on `release`,
 * `resume`, `reopen`, `cancel`, `escalate`, `move`) belong in trusted host
 * code only. Never expose them as agent tools.
 *
 * Every method takes the host's `ctx` first. Writes need a mutation ctx and
 * reads need a query ctx. Failures throw a coded error: test it with
 * `isTicketsError`. In the example, `ctx` is the mutation ctx of a host handler.
 *
 * @typeParam Q - The queue definitions, keyed by queue name.
 * @example
 * import { Tickets, defineQueue } from "@vllnt/convex-tickets";
 * import { components } from "./_generated/api";
 *
 * const queues = { support: defineQueue({}) };
 * export const tickets = new Tickets(components.tickets, { queues });
 *
 * const ticketId = await tickets.open(ctx, {
 *   queue: "support",
 *   actor: { ref: "user:ada", kind: "human" },
 *   title: "Printer is down",
 * });
 */
export class Tickets<Q extends QueueMap> {
  /** The component's function references. */
  public readonly component: ComponentApi;
  /** The queue definitions this client was built with. */
  public readonly queues: Q;
  private readonly options: TicketsOptions<Q>;

  /**
   * Create the client for one mount of the component.
   *
   * @param component - `components.tickets` (or your mount name) from `_generated/api`.
   * @param options - Queue definitions, the hook and limits.
   */
  constructor(component: ComponentApi, options: TicketsOptions<Q>) {
    this.component = component;
    this.queues = options.queues;
    this.options = options;
  }

  /**
   * Write queues, states, field types, limits and the hook handle into the
   * component. Run once per deploy from an internal mutation. Additive only:
   * a state's category cannot change, a state in use cannot be dropped, a
   * field cannot be removed or change type.
   *
   * @param ctx - A mutation ctx from the host.
   * @returns The names of the queues `created`, `updated` and `unchanged`.
   * @throws `INVALID_ARGUMENT` when `onEventHandle` did not come from `createFunctionHandle`, `retentionMs` is not a positive number, or a limit is not a positive integer or is over its ceiling.
   * @throws `INVALID_QUEUE` when two queues share a name, a queue definition is invalid (the client also throws this when `states` is an array), or `leaseMs` would switch between a number and `null` while a ticket is started.
   * @throws `STATE_CATEGORY_CHANGED` when a state would change category.
   * @throws `FIELD_CHANGED` when a field or result field would be removed, change type or lose an enum option.
   * @throws `STATE_IN_USE` when a dropped state still has tickets.
   */
  async sync(ctx: RunMutationCtx): Promise<FunctionReturnType<M["sync"]>> {
    const onEventHandle = this.options.onEvent ? await createFunctionHandle(this.options.onEvent) : undefined;
    return await ctx.runMutation(this.component.mutations.sync, {
      queues: Object.entries(this.queues).map(([name, definition]) => toQueueDef(name, definition)),
      onEventHandle,
      limits: this.options.limits,
      retentionMs: this.options.retentionMs,
    });
  }

  /**
   * Open a ticket. `fields` is checked against the queue. A repeated idempotency key returns the first ticket's id.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `queue`, `actor` (the requester) and `title` are required. Optional: `to` (an unstarted or backlog state), `priority` (an integer from 0, urgent, to 4; default 2), `subjectRef`, `parentId`, `blockedBy` (tickets that must complete first), `idempotencyKey` (counted per requester), `body` (the first public message) and `fields` (required when the queue declares a required field).
   * @returns The new ticket's id, or the first ticket's id for a repeated `idempotencyKey`.
   * @throws `UNKNOWN_QUEUE` when the queue was never synced.
   * @throws `NOT_FOUND` when the parent or a blocker does not exist.
   * @throws `INVALID_ARGUMENT` when the title is empty, `priority` is not an integer from 0 to 4, or a blocker ended without completing.
   * @throws `TOO_LONG` when the title, body or a string field is over its limit.
   * @throws `UNKNOWN_FIELD`, `INVALID_FIELD`, `MISSING_FIELD`, `TOO_MANY_FIELDS` when `fields` does not fit the queue (the client also throws `INVALID_FIELD` for a value that is not a scalar).
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not an unstarted or backlog state.
   * @throws `RATE_LIMITED` when the requester is over the opens-per-minute limit; the error data carries `retryAt`.
   * @throws `TOO_MANY_OPEN` when the requester already has `maxOpenPerRequester` active tickets in the queue.
   * @throws `TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED` when a blocker cap would be passed.
   */
  async open<K extends QueueName<Q>>(
    ctx: RunMutationCtx,
    args: {
      queue: K;
      actor: Party;
      title: string;
      to?: StateName<Q[K]>;
      priority?: number;
      subjectRef?: string;
      parentId?: string;
      blockedBy?: string[];
      idempotencyKey?: string;
      body?: string;
    } & FieldsArg<FieldsOf<Q[K]>>,
  ): Promise<string> {
    return await ctx.runMutation(this.component.mutations.open, { ...args, fields: toValues(args.fields) });
  }

  /**
   * Read one ticket with its links, blockers and recent messages. Internal notes need `view: "internal"`.
   *
   * @param ctx - A query ctx (or mutation ctx) from the host.
   * @param args - `ticketId`; `view` (`public` by default); `queue` (optional: check that the ticket is in this queue).
   * @returns The ticket with its lease expiry, up to 100 links, blockers and the 20 most recent messages (oldest first), or null when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   */
  async get(
    ctx: RunQueryCtx,
    args: { ticketId: string; view?: Visibility; queue?: QueueName<Q> },
  ): Promise<TicketDetail | null> {
    return await ctx.runQuery(this.component.queries.get, {
      ticketId: args.ticketId,
      view: args.view,
      queue: args.queue,
    });
  }

  /**
   * Narrow a ticket to one queue's field and result types. Checks the queue name
   * and every declared value at runtime.
   *
   * @param ticket - A ticket from `get` or `list`.
   * @param queue - The queue to narrow to.
   * @returns True when the ticket is in `queue` and its values fit the definition.
   */
  isIn<K extends QueueName<Q>>(ticket: TicketView, queue: K): ticket is TicketView & TypedTicket<Q[K]> {
    if (ticket.queue !== queue) return false;
    const definition = this.queues[queue];
    const fits = (specs: FieldsSpec | undefined, values: Record<string, Scalar> | undefined) =>
      Object.entries(values ?? {}).every(([key, value]) => valueFits(specs?.[key], value));
    return fits(definition?.fields, ticket.fields) && fits(definition?.result, ticket.result);
  }

  /**
   * Page through tickets by queue, assignee, requester, subject or parent.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `filter` picks one index range: `{ by: "queue", queue, state? or category? }`, `{ by: "assignee", assigneeRef, category? }`, `{ by: "requester", requesterRef, category? }`, `{ by: "subject", subjectRef }` or `{ by: "parent", parentId }`. `paginationOpts` is the Convex pagination options.
   * @returns One page of tickets, with `isDone` and `continueCursor`.
   * @throws `INVALID_ARGUMENT` when a queue filter gives both `state` and `category`.
   */
  async list(
    ctx: RunQueryCtx,
    args: { filter: ListFilter; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["list"]>> {
    return await ctx.runQuery(this.component.queries.list, args);
  }

  /**
   * Full-text search over titles.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `text` to search for; optional `queue` and `category` filters; `limit` (an integer from 1 to 100; default 20).
   * @returns Up to `limit` matching tickets.
   * @throws `INVALID_ARGUMENT` when `limit` is not an integer from 1 to 100.
   */
  async search(
    ctx: RunQueryCtx,
    args: { text: string; queue?: QueueName<Q>; category?: Category; limit?: number },
  ): Promise<TicketView[]> {
    return await ctx.runQuery(this.component.queries.search, args);
  }

  /**
   * Page through a ticket's thread, oldest first.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `ticketId`; `view` (`public` by default, `internal` adds internal notes); `paginationOpts`.
   * @returns One page of messages, with `isDone` and `continueCursor`.
   */
  async listMessages(
    ctx: RunQueryCtx,
    args: { ticketId: string; view?: Visibility; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listMessages"]>> {
    return await ctx.runQuery(this.component.queries.listMessages, args);
  }

  /**
   * Page through a ticket's history, oldest first.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `ticketId` and `paginationOpts`.
   * @returns One page of transitions, with `isDone` and `continueCursor`.
   */
  async listTransitions(
    ctx: RunQueryCtx,
    args: { ticketId: string; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listTransitions"]>> {
    return await ctx.runQuery(this.component.queries.listTransitions, args);
  }

  /**
   * Every link to one outside thing (`refKind` + `ref`), such as a label or an agent thread.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `refKind`, `ref` and `paginationOpts`.
   * @returns One page of links, with `isDone` and `continueCursor`.
   */
  async listByRef(
    ctx: RunQueryCtx,
    args: { refKind: string; ref: string; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listByRef"]>> {
    return await ctx.runQuery(this.component.queries.listByRef, args);
  }

  /**
   * The stored definition of one queue, or null before `sync`.
   *
   * @param ctx - A query ctx from the host.
   * @param args - `name`: the queue name.
   * @returns The queue's states, fields, result fields, policy, schema version and update time, or null.
   */
  async getQueue(ctx: RunQueryCtx, args: { name: QueueName<Q> }): Promise<FunctionReturnType<Qs["getQueue"]>> {
    return await ctx.runQuery(this.component.queries.getQueue, args);
  }

  /**
   * Claim a named ticket, or the next one in `queue` (reserved for the caller
   * first, then unassigned by priority and age). One transaction.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `actor`, and either `ticketId` or `queue`. Optional `to`: the started state to land in.
   * @returns `{ ok: true, ticketId, claimSeq, state, leaseExpiresAt? }` on a win (a ticket the actor already holds returns this too), or `{ ok: false, reason }` with `TAKEN`, `BLOCKED`, `RESERVED`, `EMPTY` or `NOT_CLAIMABLE`. Keep `claimSeq`: every later write by the holder needs it.
   * @throws `INVALID_ARGUMENT` when neither `ticketId` nor `queue` is given.
   * @throws `UNKNOWN_QUEUE` when claiming by `queue` and the queue was never synced.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a started state.
   */
  async claim<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: { actor: Party; ticketId?: string; queue?: K; to?: StateName<Q[K]> },
  ): Promise<ClaimResult> {
    return await ctx.runMutation(this.component.mutations.claim, args);
  }

  /**
   * Extend the holder's lease. Returns `{ expiresAt: null }` in a queue without a lease.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `claimSeq` from `claim`.
   * @returns `{ expiresAt }`: the new expiry in epoch ms, or null.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   */
  async renew(ctx: RunMutationCtx, args: Holder): Promise<FunctionReturnType<M["renew"]>> {
    return await ctx.runMutation(this.component.mutations.renew, args);
  }

  /**
   * Give a started ticket back to its queue.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId` and `actor`; the holder's `claimSeq`, or `trusted: true` from host code; optional `to` (an unstarted state) and `reason`.
   * @returns Where the ticket is now: `queue`, `state`, `category` and the new `claimSeq`.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_ARGUMENT` when `claimSeq` is missing on a call that is not `trusted`.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not an unstarted state.
   */
  async release(ctx: RunMutationCtx, args: HostVouched & { to?: string; reason?: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.release, args);
  }

  /**
   * Host move. Reserve an unstarted ticket for a party, clear the reservation, or replace a holder.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`; `actor` (who assigns); `assignee` (a party, or null to clear a reservation); optional `reason`.
   * @returns Where the ticket is now. Assigning the party it already has changes nothing.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_MOVE` when the ticket is done or canceled.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `HOLDER_REQUIRED` when `assignee` is null on a started or waiting ticket.
   */
  async assign(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; assignee: Party | null; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.assign, args);
  }

  /**
   * Change the state inside one category, or between backlog and unstarted.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `to` (the target state); optional `queue` (check the ticket's queue). A started or waiting ticket needs the holder's `claimSeq`, or `trusted: true` from host code.
   * @returns Where the ticket is now. Moving to the state it is already in changes nothing.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   * @throws `SEALED` when the ticket is closed.
   * @throws `UNKNOWN_STATE` when `to` is not a state of the queue.
   * @throws `INVALID_MOVE` when `to` is in another category; only backlog and unstarted may swap.
   * @throws `INVALID_TARGET` when a waiting ticket is moved to a waiting state that does not fit what it waits on.
   * @throws `INVALID_ARGUMENT` when `claimSeq` is missing on a call that is not `trusted`.
   * @throws `CLAIM_LOST`, `NOT_HOLDER` when a held ticket is moved without its holder's current `claimSeq` and `actor`.
   */
  async move<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: HostVouched & { queue?: K; to: StateName<Q[K]> },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.move, args);
  }

  /**
   * Ask the requester for input, naming the queue fields needed. The lease stops.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `claimSeq` of the holder; `body` (the question); optional `fields` (queue field names the answer should give), `to` (a waiting state) and `queue`.
   * @returns Where the ticket is now (a waiting category) and the new `messageId`.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   * @throws `SEALED` when the ticket is closed.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `body` is over the body limit.
   * @throws `UNKNOWN_FIELD` when a requested field is not declared by the queue.
   * @throws `MESSAGE_LIMIT` when the ticket already has `maxMessages` messages.
   * @throws `RATE_LIMITED` when `actor` is over the messages-per-minute limit; the error data carries `retryAt`.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a waiting state that waits on the requester.
   * @throws `NO_LANDING_STATE` when the queue has no waiting state for the requester.
   */
  async requestInput<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: Holder & { queue?: K; body: string; fields?: (keyof FieldsOf<Q[K]> & string)[]; to?: StateName<Q[K]> },
  ): Promise<FunctionReturnType<M["requestInput"]>> {
    return await ctx.runMutation(this.component.mutations.requestInput, args);
  }

  /**
   * Add a public message or an internal note. The requester answering an input request may supply fields.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `body`; optional `visibility` (`public` by default), `fields` (only from the requester answering an input request), `idempotencyKey` and `queue`.
   * @returns `{ ok: true, messageId, resumed, duplicate }` (`resumed` is true when the reply returned the ticket to work; `duplicate` is true for a repeated `idempotencyKey`), or `{ ok: false, reason: "MESSAGE_LIMIT", escalated }` when the ticket is full.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   * @throws `SEALED` when the ticket is closed.
   * @throws `TOO_LONG` when `body` or a string field is over its limit.
   * @throws `FIELDS_NOT_ACCEPTED` when `fields` is given by anyone but the requester answering an input request.
   * @throws `UNKNOWN_FIELD`, `INVALID_FIELD`, `MISSING_FIELD`, `TOO_MANY_FIELDS` when `fields` does not fit the queue (the client also throws `INVALID_FIELD` for a value that is not a scalar).
   * @throws `RATE_LIMITED` when `actor` is over the messages-per-minute limit; the error data carries `retryAt`.
   */
  async reply<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: {
      ticketId: string;
      actor: Party;
      body: string;
      queue?: K;
      visibility?: Visibility;
      fields?: PartialFieldValues<FieldsOf<Q[K]>>;
      idempotencyKey?: string;
    },
  ): Promise<ReplyResult> {
    return await ctx.runMutation(this.component.mutations.reply, { ...args, fields: toValues(args.fields) });
  }

  /**
   * Pause work: wait on new or existing blockers, or on something external until `resume`.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `claimSeq` of the holder; optional `blockers` (tickets to wait on), `waitingOn` (`blockers` or `external`; default `external` when no blockers are given), `to` (a waiting state) and `reason`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `NOT_BLOCKED` when the hold is on blockers but none is still open.
   * @throws `NOT_FOUND` when a blocker does not exist.
   * @throws `INVALID_ARGUMENT` when a blocker ended without completing.
   * @throws `TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED` when a blocker cap would be passed.
   * @throws `CYCLE`, `GRAPH_TOO_DEEP` when a new blocks link would close a cycle, or the blocker chain is too long to check.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a waiting state that fits what the ticket waits on.
   * @throws `NO_LANDING_STATE` when the queue has no waiting state for this hold.
   */
  async hold(
    ctx: RunMutationCtx,
    args: Holder & { blockers?: string[]; waitingOn?: "blockers" | "external"; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.hold, args);
  }

  /**
   * Return a waiting ticket to work.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId` and `actor`; the holder's `claimSeq`, or `trusted: true` from host code; optional `to` (a started state) and `reason`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_ARGUMENT` when `claimSeq` is missing on a call that is not `trusted`.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a started state.
   */
  async resume(ctx: RunMutationCtx, args: HostVouched & { to?: string; reason?: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.resume, args);
  }

  /**
   * Pass a started ticket to another queue or a named party. Counts a hop.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `claimSeq` of the holder; `toQueue`, `toParty` or both; optional `fields` (checked against the target queue) and `reason`.
   * @returns `{ ok: true, queue, state, claimSeq }`, or `{ ok: false, reason, escalated }` with `HOP_LIMIT` or `PING_PONG` when the ticket has bounced too often.
   * @throws `INVALID_ARGUMENT` when neither `toQueue` nor `toParty` is given.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `UNKNOWN_QUEUE` when `toQueue` was never synced.
   * @throws `UNKNOWN_FIELD`, `INVALID_FIELD`, `MISSING_FIELD`, `TOO_MANY_FIELDS`, `TOO_LONG` when `fields` does not fit the target queue (the client also throws `INVALID_FIELD` for a value that is not a scalar).
   */
  async handoff<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: Holder & { toQueue?: K; toParty?: Party; fields?: PartialFieldValues<FieldsOf<Q[K]>>; reason?: string },
  ): Promise<HandoffResult> {
    return await ctx.runMutation(this.component.mutations.handoff, { ...args, fields: toValues(args.fields) });
  }

  /**
   * Finish with a resolution and a result typed by the queue.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `claimSeq` of the holder; `resolution` (`completed`, `failed` or `rejected`); optional `result` (checked against the queue's result fields), `body` (a closing message), `to` (a done state) and `queue`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
   * @throws `SEALED` when the ticket is closed.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `UNKNOWN_FIELD`, `INVALID_FIELD`, `MISSING_FIELD`, `TOO_MANY_FIELDS`, `TOO_LONG` when `result` does not fit the queue's result fields; `completed` needs every required one (the client also throws `INVALID_FIELD` for a value that is not a scalar).
   * @throws `TOO_LONG` when `body` is over the body limit.
   * @throws `MESSAGE_LIMIT` when `body` is given and the ticket already has `maxMessages` messages.
   * @throws `RATE_LIMITED` when `body` is given and `actor` is over the messages-per-minute limit; the error data carries `retryAt`.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a done state.
   */
  async resolve<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: Holder & {
      queue?: K;
      resolution: Resolution;
      result?: PartialFieldValues<ResultOf<Q[K]>>;
      body?: string;
      to?: StateName<Q[K]>;
    },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.resolve, { ...args, result: toValues(args.result) });
  }

  /**
   * Reopen a done or canceled ticket before the seal. Requester, or `trusted`.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId` and `actor`; `trusted: true` from host code; optional `to` (an unstarted state) and `reason`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_MOVE` when the ticket is not done or canceled.
   * @throws `NOT_REQUESTER` when `actor` is not the requester and the call is not `trusted`.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `TOO_MANY_OPEN` when the requester already has `maxOpenPerRequester` active tickets in the queue.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not an unstarted state.
   */
  async reopen(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; trusted?: boolean; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.reopen, args);
  }

  /**
   * Host move. Seal a done or canceled ticket now.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId` and `actor`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_MOVE` when the ticket is not done or canceled.
   */
  async close(ctx: RunMutationCtx, args: { ticketId: string; actor: Party }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.close, args);
  }

  /**
   * Call a ticket off. Requester, or `trusted`.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId` and `actor`; `trusted: true` from host code; optional `to` (a canceled state) and `reason`.
   * @returns Where the ticket is now.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_MOVE` when the ticket is already done or canceled.
   * @throws `NOT_REQUESTER` when `actor` is not the requester and the call is not `trusted`.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `UNKNOWN_STATE`, `INVALID_TARGET` when `to` is not a state of the queue, or is not a canceled state.
   */
  async cancel(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; trusted?: boolean; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.cancel, args);
  }

  /**
   * Send a ticket to its queue's `escalateTo`. Holder, or `trusted`.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `reason`; the holder's `claimSeq`, or `trusted: true` from host code.
   * @returns Where the ticket is now: in the escalation queue, unstarted and unassigned.
   * @throws `NOT_FOUND` when the ticket does not exist.
   * @throws `SEALED` when the ticket is closed.
   * @throws `INVALID_ARGUMENT` when `claimSeq` is missing on a call that is not `trusted`.
   * @throws `CLAIM_LOST` when `claimSeq` is stale or the lease has expired.
   * @throws `INVALID_MOVE` when the ticket is not in a category this verb accepts.
   * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
   * @throws `TOO_LONG` when `reason` is over the string limit.
   * @throws `NO_ESCALATION` when the queue has no `escalateTo`.
   */
  async escalate(ctx: RunMutationCtx, args: HostVouched & { reason: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.escalate, args);
  }

  /**
   * Link a ticket: `blocks` (ticketId blocks toTicketId), `duplicates`, `relates`, or `ref` to an outside thing.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `ticketId`, `actor` and `relation`; `toTicketId` for `blocks`, `duplicates` and `relates`; `refKind` and `ref` for `ref`; optional `label`.
   * @returns The new link's id, or the existing link's id when the same link is already there.
   * @throws `NOT_FOUND` when the ticket or `toTicketId` does not exist.
   * @throws `SEALED` when the ticket is closed, or for a `blocks` link the ticket that would wait is.
   * @throws `TOO_LONG` when `refKind`, `ref` or `label` is over the string limit.
   * @throws `INVALID_ARGUMENT` when a `ref` link lacks `refKind` or `ref` or has a `toTicketId`, another relation lacks `toTicketId`, a ticket links to itself, or the blocker of a `blocks` link ended without completing.
   * @throws `TOO_MANY_BLOCKERS`, `TOO_MANY_BLOCKED` when a blocker cap would be passed.
   * @throws `CYCLE`, `GRAPH_TOO_DEEP` when a `blocks` link would close a cycle (or make a ticket block itself), or the blocker chain is too long to check.
   */
  async link(
    ctx: RunMutationCtx,
    args: {
      ticketId: string;
      actor: Party;
      relation: "blocks" | "duplicates" | "relates" | "ref";
      toTicketId?: string;
      refKind?: string;
      ref?: string;
      label?: string;
    },
  ): Promise<string> {
    return await ctx.runMutation(this.component.mutations.link, args);
  }

  /**
   * Remove a link.
   *
   * @param ctx - A mutation ctx from the host.
   * @param args - `linkId`.
   * @returns Null.
   * @throws `NOT_FOUND` when the link does not exist.
   * @throws `SEALED` when the link's owner is closed (for a `blocks` link: when the waiting ticket is; a sealed blocker's link can still be removed, so its dependents can be freed).
   */
  async unlink(ctx: RunMutationCtx, args: { linkId: string }): Promise<null> {
    return await ctx.runMutation(this.component.mutations.unlink, args);
  }
}
