import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { categoryValidator, transitionTypeValidator } from "../../src/shared.js";

/** Host tables of the example app. The component's own tables live in its sandbox. */
export default defineSchema({
  /** Every hook event the app received, to show delivery and order. */
  ticketEvents: defineTable({
    mount: v.string(),
    ticketId: v.string(),
    seq: v.number(),
    type: transitionTypeValidator,
    queue: v.string(),
    state: v.string(),
    category: categoryValidator,
    blocked: v.boolean(),
    actorRef: v.string(),
    assigneeRef: v.optional(v.string()),
    at: v.number(),
  }).index("by_ticket", ["ticketId", "seq"]),
});
