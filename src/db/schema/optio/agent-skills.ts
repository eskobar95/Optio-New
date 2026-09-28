import { primaryKey, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { optioSchema } from "./tenants.js";
import { skills } from "./skills.js";

export const agentSkills = optioSchema.table(
  "agent_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId], name: "agent_skills_pkey" })],
);
