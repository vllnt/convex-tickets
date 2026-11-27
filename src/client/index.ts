import { createFunctionHandle } from "convex/server";
import type { FunctionArgs, FunctionReference, FunctionReturnType, PaginationOptions } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { DEFAULT_POLICY, DEFAULT_STATES } from "../shared.js";
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
 */
export function toQueueDef(name: string, definition: AnyQueue) {
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
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Copy typed field values into the plain scalar record the component takes, dropping unset keys.
 *
 * @param input - Typed field or result values.
 * @returns A scalar record, or undefined when nothing was given.
 */
export function toValues(input: object | undefined): Record<string, Scalar> | undefined {
  if (input === undefined) return undefined;
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, Scalar] => isScalar(entry[1])));
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
 */
export class Tickets<Q extends QueueMap> {
  /** The component's function references. */
  public readonly component: ComponentApi;
  /** The queue definitions this client was built with. */
  public readonly queues: Q;
  private readonly options: TicketsOptions<Q>;

  /**
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

  /** Open a ticket. `fields` is checked against the queue. A repeated idempotency key returns the first ticket's id. */
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

  /** Read one ticket with its links, blockers and recent messages. Internal notes need `view: "internal"`. */
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

  /** Page through tickets by queue, assignee, requester, subject or parent. */
  async list(
    ctx: RunQueryCtx,
    args: { filter: ListFilter; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["list"]>> {
    return await ctx.runQuery(this.component.queries.list, args);
  }

  /** Full-text search over titles. */
  async search(
    ctx: RunQueryCtx,
    args: { text: string; queue?: QueueName<Q>; category?: Category; limit?: number },
  ): Promise<TicketView[]> {
    return await ctx.runQuery(this.component.queries.search, args);
  }

  /** Page through a ticket's thread, oldest first. */
  async listMessages(
    ctx: RunQueryCtx,
    args: { ticketId: string; view?: Visibility; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listMessages"]>> {
    return await ctx.runQuery(this.component.queries.listMessages, args);
  }

  /** Page through a ticket's history, oldest first. */
  async listTransitions(
    ctx: RunQueryCtx,
    args: { ticketId: string; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listTransitions"]>> {
    return await ctx.runQuery(this.component.queries.listTransitions, args);
  }

  /** Every link to one outside thing (`refKind` + `ref`), such as a label or an agent thread. */
  async listByRef(
    ctx: RunQueryCtx,
    args: { refKind: string; ref: string; paginationOpts: PaginationOptions },
  ): Promise<FunctionReturnType<Qs["listByRef"]>> {
    return await ctx.runQuery(this.component.queries.listByRef, args);
  }

  /** The stored definition of one queue, or null before `sync`. */
  async getQueue(ctx: RunQueryCtx, args: { name: QueueName<Q> }): Promise<FunctionReturnType<Qs["getQueue"]>> {
    return await ctx.runQuery(this.component.queries.getQueue, args);
  }

  /**
   * Claim a named ticket, or the next one in `queue` (reserved for the caller
   * first, then unassigned by priority and age). One transaction.
   */
  async claim<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: { actor: Party; ticketId?: string; queue?: K; to?: StateName<Q[K]> },
  ): Promise<ClaimResult> {
    return await ctx.runMutation(this.component.mutations.claim, args);
  }

  /** Extend the holder's lease. Returns `{ expiresAt: null }` in a queue without a lease. */
  async renew(ctx: RunMutationCtx, args: Holder): Promise<FunctionReturnType<M["renew"]>> {
    return await ctx.runMutation(this.component.mutations.renew, args);
  }

  /** Give a started ticket back to its queue. */
  async release(ctx: RunMutationCtx, args: HostVouched & { to?: string; reason?: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.release, args);
  }

  /** Host move. Reserve an unstarted ticket for a party, clear the reservation, or replace a holder. */
  async assign(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; assignee: Party | null; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.assign, args);
  }

  /** Change the state inside one category, or between backlog and unstarted. */
  async move<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: HostVouched & { queue?: K; to: StateName<Q[K]> },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.move, args);
  }

  /** Ask the requester for input, naming the queue fields needed. The lease stops. */
  async requestInput<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: Holder & { queue?: K; body: string; fields?: (keyof FieldsOf<Q[K]> & string)[]; to?: StateName<Q[K]> },
  ): Promise<FunctionReturnType<M["requestInput"]>> {
    return await ctx.runMutation(this.component.mutations.requestInput, args);
  }

  /** Add a public message or an internal note. The requester answering an input request may supply fields. */
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

  /** Pause work: wait on new or existing blockers, or on something external until `resume`. */
  async hold(
    ctx: RunMutationCtx,
    args: Holder & { blockers?: string[]; waitingOn?: "blockers" | "external"; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.hold, args);
  }

  /** Return a waiting ticket to work. */
  async resume(ctx: RunMutationCtx, args: HostVouched & { to?: string; reason?: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.resume, args);
  }

  /** Pass a started ticket to another queue or a named party. Counts a hop. */
  async handoff<K extends QueueName<Q> = QueueName<Q>>(
    ctx: RunMutationCtx,
    args: Holder & { toQueue?: K; toParty?: Party; fields?: PartialFieldValues<FieldsOf<Q[K]>>; reason?: string },
  ): Promise<HandoffResult> {
    return await ctx.runMutation(this.component.mutations.handoff, { ...args, fields: toValues(args.fields) });
  }

  /** Finish with a resolution and a result typed by the queue. */
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

  /** Reopen a done or canceled ticket before the seal. Requester, or `trusted`. */
  async reopen(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; trusted?: boolean; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.reopen, args);
  }

  /** Host move. Seal a done or canceled ticket now. */
  async close(ctx: RunMutationCtx, args: { ticketId: string; actor: Party }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.close, args);
  }

  /** Call a ticket off. Requester, or `trusted`. */
  async cancel(
    ctx: RunMutationCtx,
    args: { ticketId: string; actor: Party; trusted?: boolean; to?: string; reason?: string },
  ): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.cancel, args);
  }

  /** Send a ticket to its queue's `escalateTo`. Holder, or `trusted`. */
  async escalate(ctx: RunMutationCtx, args: HostVouched & { reason: string }): Promise<MoveResult> {
    return await ctx.runMutation(this.component.mutations.escalate, args);
  }

  /** Link a ticket: `blocks` (ticketId blocks toTicketId), `duplicates`, `relates`, or `ref` to an outside thing. */
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

  /** Remove a link. */
  async unlink(ctx: RunMutationCtx, args: { linkId: string }): Promise<null> {
    return await ctx.runMutation(this.component.mutations.unlink, args);
  }
}
