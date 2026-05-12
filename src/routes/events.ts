import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client.js";
import {
  events,
  subscriptions,
  type Event,
} from "../db/schema/index.js";
import { requireOrg } from "../lib/auth.js";
import { asyncHandler } from "../lib/async.js";
import { unprocessable } from "../lib/errors.js";
import { CreateEventRequest } from "../schemas/events.js";
import {
  applyEventToLifecycle,
  findBmByCode,
} from "../lib/billing/event-lifecycle.js";

export type EventResponse = {
  lago_id: string;
  transaction_id: string;
  lago_customer_id: null;
  code: string;
  // ISO string, even though the request was epoch seconds.
  timestamp: string;
  precise_total_amount_cents: number | null;
  properties: Record<string, unknown>;
  lago_subscription_id: null;
  external_subscription_id: string;
  created_at: string;
};

function serializeEvent(e: Event): EventResponse {
  return {
    lago_id: e.id,
    transaction_id: e.transactionId,
    lago_customer_id: null,
    code: e.code,
    timestamp: e.timestamp.toISOString(),
    precise_total_amount_cents: e.preciseTotalAmountCents ?? null,
    properties: e.properties as Record<string, unknown>,
    lago_subscription_id: null,
    external_subscription_id: e.externalSubscriptionId,
    created_at: e.createdAt.toISOString(),
  };
}

function bodyHash(input: {
  externalSubscriptionId: string;
  code: string;
  timestamp: number;
  preciseTotalAmountCents: number | null;
  properties: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    s: input.externalSubscriptionId,
    c: input.code,
    t: input.timestamp,
    p: input.preciseTotalAmountCents,
    pr: input.properties,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildEventsRouter(db: DB): Router {
  const router = Router();

  // POST /events
  // - timestamp is Unix epoch in seconds (number; strings rejected at zod).
  // - transaction_id is UNIQUE per org; duplicates → 422 always (Lago).
  // - For unique_count_agg + recurring BMs we advance subscription_units.
  //   The subscription row is locked SELECT FOR UPDATE inside the tx so
  //   concurrent add/remove on the same sub don't race.
  router.post(
    "/events",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const { event: input } = CreateEventRequest.parse(req.body);

      const timestamp = new Date(input.timestamp * 1000);
      const hash = bodyHash({
        externalSubscriptionId: input.external_subscription_id,
        code: input.code,
        timestamp: input.timestamp,
        preciseTotalAmountCents: input.precise_total_amount_cents ?? null,
        properties: input.properties,
      });

      const stored = await db.transaction(async (tx) => {
        const [duplicate] = await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.organizationId, org.id),
              eq(events.transactionId, input.transaction_id),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw unprocessable(
            "validation_errors",
            "Unprocessable Entity",
            { transaction_id: ["value_already_exist"] },
          );
        }

        const bm = await findBmByCode(tx, org.id, input.code);
        if (!bm) {
          throw unprocessable(
            "validation_errors",
            "Unprocessable Entity",
            { code: ["value_is_invalid"] },
          );
        }

        // Lock the subscription row so concurrent add/remove for the same
        // sub serialize. Subscription presence is optional — Lago itself
        // resolves the link asynchronously (response shows null ids).
        const [sub] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.organizationId, org.id),
              eq(subscriptions.externalId, input.external_subscription_id),
            ),
          )
          .for("update")
          .limit(1);

        const [inserted] = await tx
          .insert(events)
          .values({
            organizationId: org.id,
            transactionId: input.transaction_id,
            externalSubscriptionId: input.external_subscription_id,
            code: input.code,
            timestamp,
            properties: input.properties,
            preciseTotalAmountCents: input.precise_total_amount_cents ?? null,
            bodyHash: hash,
          })
          .returning();
        if (!inserted) throw new Error("insert event failed");

        if (sub) {
          await applyEventToLifecycle(tx, bm, sub, {
            timestamp,
            properties: input.properties,
          });
        }

        return inserted;
      });

      res.status(200).json({ event: serializeEvent(stored) });
    }),
  );

  // GET /events/:transaction_id — handy for forensics, not in the SDK surface.
  router.get(
    "/events/:transaction_id",
    asyncHandler(async (req, res) => {
      const org = requireOrg(req);
      const txn = req.params["transaction_id"];
      const [row] = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.organizationId, org.id),
            eq(events.transactionId, String(txn ?? "")),
          ),
        )
        .limit(1);
      if (!row) {
        throw unprocessable("validation_errors", "Unprocessable Entity", {
          transaction_id: ["value_is_invalid"],
        });
      }
      res.json({ event: serializeEvent(row) });
    }),
  );

  return router;
}

// silence unused
void sql;
