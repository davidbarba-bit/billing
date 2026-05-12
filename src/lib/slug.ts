import { createHash } from "node:crypto";

/**
 * Builds Lago-style human slugs: `${ORG3}-${HASH4}-${NNN}` (e.g. `NUM-FC2D-009`).
 *
 * - `org3`: first 3 alphanumeric chars of the org slug, uppercased.
 * - `hash4`: first 4 hex chars of sha256(orgId), uppercased; gives a stable
 *   org-specific prefix that doesn't leak the slug.
 * - `nnn`: zero-padded sequential id (min width 3, grows naturally).
 */
export function buildCustomerSlug(
  orgSlug: string,
  orgId: string,
  sequentialId: number,
): string {
  const cleaned = orgSlug.replace(/[^a-zA-Z0-9]/g, "");
  const org3 = (cleaned.slice(0, 3) || "ORG").toUpperCase();
  const hash4 = createHash("sha256")
    .update(orgId)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  const nnn = String(sequentialId).padStart(3, "0");
  return `${org3}-${hash4}-${nnn}`;
}
