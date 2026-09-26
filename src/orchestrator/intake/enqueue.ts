/**
 * New Bot intake → BullMQ enqueue stub.
 * No Linear. Call from chat/API or optional webhook.
 */
import { z } from "zod";

export const IntakeTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Catalog repo. Omitted on legacy callers; HTTP and adapters set it. */
  repoId: z.string().min(1).optional(),
  source: z.enum(["http", "github", "slack"]).optional(),
  event: z.literal("bot.intake.created").optional(),
});

export type IntakeTask = z.infer<typeof IntakeTaskSchema>;

/** Validate and return a job payload ready for BullMQ (stub). */
export function buildIntakeJob(input: unknown): IntakeTask {
  return IntakeTaskSchema.parse(input);
}
