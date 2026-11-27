import type { FieldsSpec, PolicyInput, QueueDefinition, StatesSpec } from "./types.js";

const MINUTE = 60_000;

/** Optional overrides every preset accepts. Policy keys you pass win over the preset's. */
export interface PresetOptions<F extends FieldsSpec, R extends FieldsSpec> {
  /** The queue's ticket fields. */
  fields?: F;
  /** The queue's result fields. */
  result?: R;
  /** Policy overrides. */
  policy?: PolicyInput;
}

/** The desk preset's states: New, Open, Pending, On hold, Solved, Canceled. */
export const DESK_STATES = {
  new: { category: "unstarted" },
  open: { category: "started" },
  pending: { category: "waiting", on: "requester" },
  on_hold: { category: "waiting", on: "external" },
  solved: { category: "done" },
  canceled: { category: "canceled" },
} as const satisfies StatesSpec;

/** The project preset's states: Backlog, Todo, In progress, In review, Done, Canceled. */
export const PROJECT_STATES = {
  backlog: { category: "backlog" },
  todo: { category: "unstarted" },
  in_progress: { category: "started" },
  in_review: { category: "started" },
  done: { category: "done" },
  canceled: { category: "canceled" },
} as const satisfies StatesSpec;

/**
 * A queue worked by AI agents: the default five states and a 5-minute lease, so
 * a crashed agent's ticket returns to the queue.
 *
 * @param options - Fields, result fields and policy overrides.
 * @returns Settings for `defineQueue`.
 * @example
 * import { defineQueue } from "@vllnt/convex-tickets";
 * import { agentQueue } from "@vllnt/convex-tickets/presets";
 *
 * const billing = defineQueue(agentQueue({ fields: { amount: { type: "number", required: true } } }));
 */
export function agentQueue<
  const F extends FieldsSpec = Record<never, never>,
  const R extends FieldsSpec = Record<never, never>,
>(options: PresetOptions<F, R> = {}): QueueDefinition<undefined, F, R> {
  return { fields: options.fields, result: options.result, policy: { leaseMs: 5 * MINUTE, ...options.policy } };
}

/**
 * A support desk queue worked by people: New, Open, Pending (waiting on the
 * requester), On hold (waiting on something else), Solved, Canceled. No lease.
 *
 * @param options - Fields, result fields and policy overrides.
 * @returns Settings for `defineQueue`.
 * @example
 * import { defineQueue } from "@vllnt/convex-tickets";
 * import { deskQueue } from "@vllnt/convex-tickets/presets";
 *
 * const billingHumans = defineQueue(deskQueue());
 */
export function deskQueue<
  const F extends FieldsSpec = Record<never, never>,
  const R extends FieldsSpec = Record<never, never>,
>(options: PresetOptions<F, R> = {}): QueueDefinition<typeof DESK_STATES, F, R> {
  return { states: DESK_STATES, fields: options.fields, result: options.result, policy: { leaseMs: null, ...options.policy } };
}

/**
 * A project tracking queue: Backlog, Todo, In progress, In review, Done,
 * Canceled. No lease, and never sealed, so done work can always be reopened.
 *
 * @param options - Fields, result fields and policy overrides.
 * @returns Settings for `defineQueue`.
 * @example
 * import { defineQueue } from "@vllnt/convex-tickets";
 * import { projectQueue } from "@vllnt/convex-tickets/presets";
 *
 * const eng = defineQueue(projectQueue({ fields: { estimate: { type: "number" } } }));
 */
export function projectQueue<
  const F extends FieldsSpec = Record<never, never>,
  const R extends FieldsSpec = Record<never, never>,
>(options: PresetOptions<F, R> = {}): QueueDefinition<typeof PROJECT_STATES, F, R> {
  return {
    states: PROJECT_STATES,
    fields: options.fields,
    result: options.result,
    policy: { leaseMs: null, reopenWindowMs: null, ...options.policy },
  };
}
