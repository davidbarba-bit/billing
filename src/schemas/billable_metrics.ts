import { z } from "zod";
import { aggregationTypes } from "../db/schema/billable_metrics.js";

export const BillableMetricInputSchema = z
  .object({
    name: z.string().min(1),
    code: z.string().min(1),
    description: z.string().nullish(),
    aggregation_type: z.enum(aggregationTypes),
    field_name: z.string().min(1).nullish(),
    recurring: z.boolean().optional().default(false),
    weighted_interval: z.string().nullish(),
  })
  .refine(
    (m) =>
      m.aggregation_type === "count_agg" ||
      (m.field_name !== undefined && m.field_name !== null),
    {
      message: "field_name is required for this aggregation_type",
      path: ["field_name"],
    },
  )
  .refine(
    (m) =>
      !m.recurring ||
      m.aggregation_type === "unique_count_agg" ||
      m.aggregation_type === "sum_agg",
    {
      message:
        "recurring is only supported for unique_count_agg and sum_agg",
      path: ["recurring"],
    },
  );

export const CreateBillableMetricRequest = z.object({
  billable_metric: BillableMetricInputSchema,
});

export type CreateBillableMetricRequest = z.infer<
  typeof CreateBillableMetricRequest
>;
export type BillableMetricInput = z.infer<typeof BillableMetricInputSchema>;
