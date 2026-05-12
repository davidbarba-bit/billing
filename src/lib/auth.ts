import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config.js";
import type { DB } from "../db/client.js";
import { organizations, type Organization } from "../db/schema/index.js";
import { unauthorized } from "./errors.js";

declare module "express-serve-static-core" {
  interface Request {
    organization?: Organization;
    apiKey?: string;
  }
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Ensures every API key from config has a matching organization row.
 * Idempotent: safe to call on every boot.
 */
export async function syncOrganizations(
  db: DB,
  config: Config,
): Promise<void> {
  for (const entry of config.apiKeys) {
    const hash = hashApiKey(entry.key);
    await db
      .insert(organizations)
      .values({
        slug: entry.slug,
        name: entry.name,
        apiKeyHash: hash,
      })
      .onConflictDoNothing({ target: organizations.apiKeyHash });
  }
}

export function buildAuthMiddleware(db: DB) {
  return async function authMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const header = req.header("authorization");
      if (!header || !header.toLowerCase().startsWith("bearer ")) {
        throw unauthorized("missing_bearer_token", "Missing bearer token");
      }
      const apiKey = header.slice(7).trim();
      if (!apiKey) {
        throw unauthorized("missing_bearer_token", "Missing bearer token");
      }
      const hash = hashApiKey(apiKey);
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.apiKeyHash, hash))
        .limit(1);
      if (!org) {
        throw unauthorized("invalid_api_key", "Invalid API key");
      }
      req.organization = org;
      req.apiKey = apiKey;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireOrg(req: Request): Organization {
  if (!req.organization) {
    throw unauthorized("invalid_api_key", "Invalid API key");
  }
  return req.organization;
}
