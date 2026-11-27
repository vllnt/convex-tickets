/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

/* v8 ignore next -- Vite rewrites import.meta.glob into a declaration-only module map */
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the tickets component, and its rate-limiter child, with a `convex-test` instance.
 *
 * @param t - The test instance from `convexTest`.
 * @param name - The mount name used in `convex.config.ts`. Default `tickets`.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "tickets",
): void {
  t.registerComponent(name, schema, modules);
  rateLimiterTest.register(t, `${name}/rateLimiter`);
}

/* v8 ignore next -- declaration-only compatibility export; properties are tested above */
export default { register, schema, modules };
