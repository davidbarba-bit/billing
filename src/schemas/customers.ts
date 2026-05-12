import { z } from "zod";

export const BillingConfigurationSchema = z
  .object({
    invoice_grace_period: z.number().int().nonnegative().optional(),
    payment_provider: z.string().optional(),
    payment_provider_code: z.string().optional(),
    provider_customer_id: z.string().optional(),
    sync: z.boolean().optional(),
    sync_with_provider: z.boolean().optional(),
    document_locale: z.string().optional(),
  })
  .passthrough();

export const IntegrationCustomerSchema = z
  .object({
    integration_type: z.string(),
    integration_code: z.string().optional(),
    external_customer_id: z.string().optional(),
  })
  .passthrough();

export const CustomerInputSchema = z.object({
  external_id: z.string().min(1),
  name: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u, "currency must be a 3-letter ISO code")
    .optional(),
  timezone: z.string().optional(),
  billing_configuration: BillingConfigurationSchema.optional(),
  integration_customers: z.array(IntegrationCustomerSchema).optional(),
  metadata: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const CreateCustomerRequest = z.object({
  customer: CustomerInputSchema,
});

export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export const CustomerResponseSchema = z.object({
  lago_id: z.string().uuid(),
  external_id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  billing_configuration: z.unknown().nullable(),
  integration_customers: z.unknown().nullable(),
  metadata: z.unknown().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CustomerResponse = z.infer<typeof CustomerResponseSchema>;
