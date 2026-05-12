import { z } from "zod";

export const TaxInputSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  // Lago's SDK ships `rate` as a string ("16") — accept both string and number.
  rate: z.coerce.number().min(0).max(100),
  description: z.string().nullish(),
  applied_to_organization: z.boolean().optional().default(false),
});

export const CreateTaxRequest = z.object({
  tax: TaxInputSchema,
});

export type CreateTaxRequest = z.infer<typeof CreateTaxRequest>;
export type TaxInput = z.infer<typeof TaxInputSchema>;
