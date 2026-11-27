import { Tickets, defineQueue } from "../../src/client/index.js";
import {
  agentQueue,
  deskQueue,
  projectQueue,
} from "../../src/client/presets.js";
import { components, internal } from "./_generated/api.js";

const MINUTE = 60_000;

/**
 * The example app's queues. One mount, four queues, one hook:
 * - `billing`: worked by an AI agent. Lease on (5 minutes), due in an hour.
 * - `approvals`: worked by people. Lease off, so an approver may hold a ticket for days.
 * - `billing-humans`: the desk preset, where billing escalates.
 * - `eng`: the project preset with an estimate field.
 */
const queues = {
  billing: defineQueue(
    agentQueue({
      fields: {
        amount: { type: "number", required: true },
        currency: { type: "enum", options: ["EUR", "USD"], required: true },
        orderId: { type: "string" },
      },
      result: {
        refunded: { type: "boolean", required: true },
        refundId: { type: "string" },
      },
      policy: {
        dueInMs: 60 * MINUTE,
        maxHops: 6,
        escalateTo: "billing-humans",
      },
    }),
  ),
  approvals: defineQueue({
    fields: { amount: { type: "number", required: true } },
    result: { approved: { type: "boolean", required: true } },
    policy: { leaseMs: null },
  }),
  "billing-humans": defineQueue(deskQueue()),
  eng: defineQueue(projectQueue({ fields: { estimate: { type: "number" } } })),
};

/** The main mount's client. The explicit type keeps the generated api from referring back to itself. */
export const tickets: Tickets<typeof queues> = new Tickets(components.tickets, {
  queues,
  onEvent: internal.hooks.onEvent,
});

const strictQueues = { jobs: defineQueue({}) };

/** A second mount of the same component, with a hook that always throws. */
export const strictTickets: Tickets<typeof strictQueues> = new Tickets(
  components.strictTickets,
  {
    queues: strictQueues,
    onEvent: internal.hooks.failingHook,
    limits: { opensPerMinute: 2 },
    retentionMs: 30 * 24 * 60 * MINUTE,
  },
);

/** The parties of the refund example. In a real app the host binds these from its auth. */
export const parties = {
  support: { ref: "agent:support", kind: "agent" },
  billing: { ref: "agent:billing", kind: "agent" },
  approver: { ref: "user:approver", kind: "human" },
  lead: { ref: "user:lead", kind: "human" },
  coder: { ref: "agent:coder", kind: "agent" },
} as const;
