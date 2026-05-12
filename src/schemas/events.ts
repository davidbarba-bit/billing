import { z } from "zod";

export const operationTypes = ["add", "remove"] as const;

export const EventInputSchema = z.object({
  transaction_id: z.string().min(1),
  external_subscription_id: z.string().min(1),
  code: z.string().min(1),
  // Lago wires the event timestamp as Unix epoch in SECONDS (number). Strings
  // (ISO or numeric) are rejected — Lago Cloud silently mis-parses ISO as 0
  // which leads to invisibly-empty periods; mini-Lago refuses (422).
  timestamp: z.number().int().nonnegative(),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
  precise_total_amount_cents: z.coerce.number().nullish(),
});

export const CreateEventRequest = z.object({
  event: EventInputSchema,
});

export type CreateEventRequest = z.infer<typeof CreateEventRequest>;
export type EventInput = z.infer<typeof EventInputSchema>;
