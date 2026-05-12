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

export const ShippingAddressSchema = z
  .object({
    address_line1: z.string().nullish(),
    address_line2: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    zipcode: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();

const nullableString = z.string().nullish();

export const CustomerInputSchema = z.object({
  external_id: z.string().min(1),

  // Identity
  name: nullableString,
  firstname: nullableString,
  lastname: nullableString,
  customer_type: z.enum(["company", "individual"]).nullish(),
  legal_name: nullableString,
  legal_number: nullableString,
  tax_identification_number: nullableString,
  email: z.string().email().nullish().or(z.literal("")),
  phone: nullableString,
  url: nullableString,
  logo_url: nullableString,

  // Address
  address_line1: nullableString,
  address_line2: nullableString,
  city: nullableString,
  state: nullableString,
  zipcode: nullableString,
  country: z
    .string()
    .regex(/^[A-Z]{2}$/u, "country must be a 2-letter ISO code")
    .nullish(),

  // Money / locale
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u, "currency must be a 3-letter ISO code")
    .nullish(),
  timezone: nullableString,
  net_payment_term: z.number().int().nonnegative().nullish(),
  external_salesforce_id: nullableString,
  finalize_zero_amount_invoice: z
    .enum(["inherit", "finalize", "skip"])
    .nullish(),

  // Embeds
  billing_configuration: BillingConfigurationSchema.nullish(),
  shipping_address: ShippingAddressSchema.nullish(),
  integration_customers: z.array(IntegrationCustomerSchema).nullish(),
  metadata: z.array(z.record(z.string(), z.unknown())).nullish(),

  // Tax linkage (Lago: array of tax codes already known)
  tax_codes: z.array(z.string()).nullish(),
});

export const CreateCustomerRequest = z.object({
  customer: CustomerInputSchema,
});

export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;
export type CustomerInput = z.infer<typeof CustomerInputSchema>;
