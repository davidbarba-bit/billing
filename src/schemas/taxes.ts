import { z } from "zod";

export const TaxInputSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  rate: z.coerce.number().min(0).max(100),
  description: z.string().optional(),
  applied_to_organization: z.boolean().optional().default(false),
});

export const CreateTaxRequest = z.object({
  tax: TaxInputSchema,
});

export type CreateTaxRequest = z.infer<typeof CreateTaxRequest>;
export type TaxInput = z.infer<typeof TaxInputSchema>;

export const TaxResponseSchema = z.object({
  lago_id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  rate: z.number(),
  description: z.string().nullable(),
  applied_to_organization: z.boolean(),
  created_at: z.string(),
});

export type TaxResponse = z.infer<typeof TaxResponseSchema>;
