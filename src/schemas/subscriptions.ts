import { z } from "zod";
import { billingTimes } from "../db/schema/subscriptions.js";

export const SubscriptionInputSchema = z
  .object({
    external_customer_id: z.string().min(1),
    plan_code: z.string().min(1),
    external_id: z.string().min(1),
    name: z.string().nullish(),
    billing_time: z.enum(billingTimes),
    subscription_at: z.string().datetime().optional(),
    ending_at: z.string().datetime().nullish(),
  })
  .refine(
    (s) => s.billing_time !== "anniversary" || s.subscription_at !== undefined,
    {
      message: "subscription_at is required for anniversary billing",
      path: ["subscription_at"],
    },
  );

export const CreateSubscriptionRequest = z.object({
  subscription: SubscriptionInputSchema,
});

export type CreateSubscriptionRequest = z.infer<
  typeof CreateSubscriptionRequest
>;
export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>;
