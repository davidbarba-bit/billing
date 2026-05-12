import { z } from "zod";

export const PaginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuery>;

export type PaginationMeta = {
  current_page: number;
  next_page: number | null;
  prev_page: number | null;
  total_pages: number;
  total_count: number;
};

export function buildMeta(
  page: number,
  perPage: number,
  totalCount: number,
): PaginationMeta {
  const totalPages = totalCount === 0 ? 1 : Math.ceil(totalCount / perPage);
  return {
    current_page: page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 ? page - 1 : null,
    total_pages: totalPages,
    total_count: totalCount,
  };
}
