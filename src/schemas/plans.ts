import { z } from "zod";
import { planIntervals } from "../db/schema/plans.js";

/**
 * Mini-Lago only ships `charge_model: "standard"` in phase 2 (D8). Numaris
 * verified to send only "standard" across its codebase.
 */
export const ChargePropertiesSchema = z
  .object({
    // Lago wires amount as a string with 2 decimals ("450.00"). Accept both
    // string and number; coerce to canonical string at serialization.
    amount: z.union([z.string().min(1), z.number()]),
  })
  .passthrough();

export const ChargeInputSchema = z.object({
  billable_metric_id: z.string().uuid(),
  charge_model: z.literal("standard"),
  invoiceable: z.boolean().optional().default(true),
  prorated: z.boolean().optional().default(false),
  pay_in_advance: z.boolean().optional().default(false),
  invoice_display_name: z.string().nullish(),
  min_amount_cents: z.coerce.number().int().nonnegative().optional().default(0),
  properties: ChargePropertiesSchema,
});

export const PlanInputSchema = z.object({
  name: z.string().min(1),
  invoice_display_name: z.string().nullish(),
  code: z.string().min(1),
  description: z.string().nullish(),
  interval: z.enum(planIntervals),
  amount_cents: z.coerce.number().int().nonnegative(),
  amount_currency: z
    .string()
    .regex(/^[A-Z]{3}$/u, "amount_currency must be a 3-letter ISO code"),
  pay_in_advance: z.boolean().optional().default(false),
  bill_charges_monthly: z.boolean().nullish(),
  trial_period: z.coerce.number().int().nonnegative().nullish(),
  charges: z.array(ChargeInputSchema).optional().default([]),
});

export const CreatePlanRequest = z.object({ plan: PlanInputSchema });
export const UpdatePlanRequest = z.object({
  plan: PlanInputSchema.partial({
    name: true,
    code: true,
    interval: true,
    amount_cents: true,
    amount_currency: true,
    charges: true,
  }),
});

export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type ChargeInput = z.infer<typeof ChargeInputSchema>;
