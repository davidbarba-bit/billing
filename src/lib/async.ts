import type { Request, Response, NextFunction, RequestHandler } from "express";
import { badRequest } from "./errors.js";

/**
 * Wraps an async handler so that thrown errors propagate to the express
 * error middleware instead of becoming unhandled rejections.
 */
export function asyncHandler<R extends RequestHandler>(handler: R): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Express 5 widened req.params to `string | string[]`. For our REST routes the
 * value is always a single segment string; this helper enforces that.
 */
export function pathParam(req: Request, key: string): string {
  const raw = req.params[key];
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw badRequest("invalid_path_param", `Missing path parameter: ${key}`);
}
