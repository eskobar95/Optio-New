import { defineConfig } from "drizzle-kit";

const DEFAULT_LOCAL_URL = "postgresql://optio:optio@127.0.0.1:5432/optio_new";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.OPTIO_NEW_DATABASE_URL?.trim() || DEFAULT_LOCAL_URL,
  },
});
