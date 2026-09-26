/**
 * New Bot intake → BullMQ enqueue stub.
 * Call from chat/API or a webhook adapter (GitHub, Slack, Linear status change).
 */
import { z } from "zod";

export const IntakeTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  /** Catalog repo. Omitted on legacy callers; HTTP and adapters set it. */
  repoId: z.string().min(1).optional(),
  source: z.enum(["http", "github", "slack", "linear"]).optional(),
  event: z.literal("bot.intake.created").optional(),
});

export type IntakeTask = z.infer<typeof IntakeTaskSchema>;

/** Validate and return a job payload ready for BullMQ (stub). */
export function buildIntakeJob(input: unknown): IntakeTask {
  return IntakeTaskSchema.parse(input);
}
