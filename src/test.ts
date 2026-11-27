/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

/* v8 ignore next -- Vite rewrites import.meta.glob into a declaration-only module map */
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the tickets component, and its rate-limiter child, with a `convex-test` instance.
 * In the example, `modules` is the host's own `import.meta.glob` map of its Convex functions.
 *
 * @param t - The test instance from `convexTest`.
 * @param name - The mount name used in `convex.config.ts`. Default `tickets`.
 * @example
 * import { convexTest } from "convex-test";
 * import { register } from "@vllnt/convex-tickets/test";
 * import schema from "./schema";
 *
 * const t = convexTest(schema, modules);
 * register(t);
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "tickets",
): void {
  t.registerComponent(name, schema, modules);
  rateLimiterTest.register(t, `${name}/rateLimiter`);
}

/** The default export: `register`, the component `schema` and its `modules` map, so `import tickets from ".../test"` and `tickets.register(t)` also work. */
/* v8 ignore next -- declaration-only compatibility export; properties are tested above */
export default { register, schema, modules };
