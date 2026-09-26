/**
 * Normalized intake event. GitHub and Slack adapters produce this shape.
 * The workflow trigger name is `bot.intake.created`. There is no Linear variant.
 */
import { z } from "zod";

export const BOT_INTAKE_CREATED = "bot.intake.created" as const;

export const IntakeSourceSchema = z.enum(["http", "github", "slack"]);

export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

export const BotIntakeCreatedSchema = z.object({
  event: z.literal(BOT_INTAKE_CREATED),
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  repoId: z.string().min(1),
  source: IntakeSourceSchema,
});

export type BotIntakeCreated = z.infer<typeof BotIntakeCreatedSchema>;
