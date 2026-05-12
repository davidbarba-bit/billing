import { z } from "zod";

export const AddOnInputSchema = z.object({
  name: z.string().min(1),
  invoice_display_name: z.string().nullish(),
  code: z.string().min(1),
  description: z.string().nullish(),
  amount_cents: z.coerce.number().int().positive(),
  amount_currency: z
    .string()
    .regex(/^[A-Z]{3}$/u, "amount_currency must be a 3-letter ISO code"),
});

export const CreateAddOnRequest = z.object({
  add_on: AddOnInputSchema,
});

export type CreateAddOnRequest = z.infer<typeof CreateAddOnRequest>;
export type AddOnInput = z.infer<typeof AddOnInputSchema>;
