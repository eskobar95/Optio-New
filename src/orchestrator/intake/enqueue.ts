/**
 * New Bot intake → BullMQ enqueue stub.
 * No Linear. Call from chat/API or optional webhook.
 */
import { z } from "zod";

export const IntakeTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
});

export type IntakeTask = z.infer<typeof IntakeTaskSchema>;

/** Validate and return a job payload ready for BullMQ (stub). */
export function buildIntakeJob(input: unknown): IntakeTask {
  return IntakeTaskSchema.parse(input);
}
