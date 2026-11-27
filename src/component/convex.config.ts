import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import { defineComponent } from "convex/server";

const component = defineComponent("tickets");

component.use(rateLimiter);

export default component;
