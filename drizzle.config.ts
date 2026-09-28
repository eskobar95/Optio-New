import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/db/database-url.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
