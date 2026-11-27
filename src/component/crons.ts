import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

/**
 * Cadence of the retention purge. Convex cron definitions are static per
 * deployment, so the cadence is a module constant; `retentionMs` (set through
 * `sync`) turns the purge on, and it is off by default.
 */
export const PURGE_INTERVAL = { hours: 24 } as const;

const crons = cronJobs();

crons.interval("tickets:purge", PURGE_INTERVAL, internal.internal_mutations.purge, {});

export default crons;
