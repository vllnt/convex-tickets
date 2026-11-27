import { defineApp } from "convex/server";
import tickets from "../../src/component/convex.config.js";

const app = defineApp();
app.use(tickets);
app.use(tickets, { name: "strictTickets" });

export default app;
