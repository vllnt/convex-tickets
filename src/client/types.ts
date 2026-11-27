import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { Category, DefaultStateName, Scalar, WaitTarget } from "../shared.js";

/** The slice of a host query ctx the client needs. */
export type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** The slice of a host mutation ctx the client needs. */
export type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation" | "runQuery">;

/** A declared field: a scalar type, or an enum of string options. */
export type FieldSpec =
  | { type: "string" | "number" | "boolean"; required?: boolean }
  | { type: "enum"; options: readonly [string, ...string[]]; required?: boolean };

/** A queue's fields (or result fields), keyed by name. */
export type FieldsSpec = Record<string, FieldSpec>;

/** One named state: its category, and for a waiting state what it waits on. */
export interface StateSpec {
  /** The status category the state belongs to. */
  category: Category;
  /** For a waiting state: what it waits on. */
  on?: WaitTarget;
}

/** A queue's states in order. The first state of a category is where verbs land. */
export type StatesSpec = Record<string, StateSpec>;

/** Queue policy. Every key has a default; see `DEFAULT_POLICY`. */
export interface PolicyInput {
  /** Lease length in ms, or `null` for a queue people work (no lease, no timer). */
  leaseMs?: number | null;
  /** Wall-clock due time after open. Off by default. */
  dueInMs?: number;
  /** How long a done or canceled ticket may be reopened. `0` seals at once, `null` never. */
  reopenWindowMs?: number | null;
  /** Handoffs a ticket may make. The next one is refused with `HOP_LIMIT`. */
  maxHops?: number;
  /** Lease expiries before the ticket escalates instead of returning to the queue. */
  maxReturns?: number;
  /** Messages a ticket may hold. Past it, `reply` returns `MESSAGE_LIMIT`; `requestInput`, and `resolve` with a body, throw it. */
  maxMessages?: number;
  /** Active tickets one requester may have in this queue. Past it, `open` throws `TOO_MANY_OPEN`. */
  maxOpenPerRequester?: number;
  /** The queue that escalations go to. */
  escalateTo?: string;
  /** Escalate when the due time passes, not only emit `due_breached`. */
  escalateOnDue?: boolean;
}

/**
 * A queue definition. Build it with `defineQueue` so state names and field
 * types are kept as literal types.
 */
export interface QueueDefinition<
  S extends StatesSpec | undefined = StatesSpec | undefined,
  F extends FieldsSpec = FieldsSpec,
  R extends FieldsSpec = FieldsSpec,
> {
  /** The queue's named states. Omit for the default five. */
  states?: S;
  /** The ticket fields the queue declares. */
  fields?: F;
  /** The result fields a resolution carries. */
  result?: R;
  /** The queue's policy. */
  policy?: PolicyInput;
}

/** Any queue definition. */
export type AnyQueue = QueueDefinition;

/** The queues a `Tickets` instance knows, by name. */
export type QueueMap = Record<string, AnyQueue>;

/** The state names of a queue: its own, or the default five. */
export type StateName<D extends AnyQueue> = D extends unknown
  ? [NonNullable<D["states"]>] extends [never]
    ? DefaultStateName
    : keyof NonNullable<D["states"]> & string
  : never;

type ValueOf<T extends FieldSpec> = T extends { type: "enum"; options: readonly (infer O)[] }
  ? O
  : T extends { type: "string" }
    ? string
    : T extends { type: "number" }
      ? number
      : T extends { type: "boolean" }
        ? boolean
        : never;

type RequiredKeys<F extends FieldsSpec> = {
  [K in keyof F]: F[K] extends { required: true } ? K : never;
}[keyof F];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Values for a set of declared fields: required keys must be present; `null` clears an optional one. */
export type FieldValues<F extends FieldsSpec> = Simplify<
  { [K in RequiredKeys<F>]: ValueOf<F[K]> } & {
    [K in Exclude<keyof F, RequiredKeys<F>>]?: ValueOf<F[K]> | null;
  }
>;

/** Values for a set of declared fields where every key is optional (replies, handoffs, reads). */
export type PartialFieldValues<F extends FieldsSpec> = Simplify<{ [K in keyof F]?: ValueOf<F[K]> | null }>;

/** The declared fields of a queue. */
export type FieldsOf<D extends AnyQueue> = NonNullable<D["fields"]>;
/** The declared result fields of a queue. */
export type ResultOf<D extends AnyQueue> = NonNullable<D["result"]>;

/** `fields` is required exactly when the queue declares a required field. */
export type FieldsArg<F extends FieldsSpec> = [RequiredKeys<F>] extends [never]
  ? { fields?: FieldValues<F> }
  : { fields: FieldValues<F> };

/** A scalar record as stored on a ticket. */
export type Values = Record<string, Scalar>;
