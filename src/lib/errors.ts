import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

export type LagoErrorBody = {
  status: number;
  error: string;
  code: string;
  error_details?: unknown;
};

export class LagoError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;

  constructor(opts: {
    status: number;
    error: string;
    code: string;
    details?: unknown;
  }) {
    super(opts.error);
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  toBody(): LagoErrorBody {
    const body: LagoErrorBody = {
      status: this.status,
      error: this.message,
      code: this.code,
    };
    if (this.details !== undefined) body.error_details = this.details;
    return body;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new LagoError({ status: 400, error: message, code, details });

export const unauthorized = (
  code = "unauthorized",
  message = "Unauthorized",
) => new LagoError({ status: 401, error: message, code });

export const notFound = (resource: string) =>
  new LagoError({
    status: 404,
    error: "Not Found",
    code: `${resource}_not_found`,
  });

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new LagoError({ status: 422, error: message, code, details });

export const conflict = (code: string, message: string, details?: unknown) =>
  new LagoError({ status: 409, error: message, code, details });

export const internal = (message = "Internal Server Error") =>
  new LagoError({ status: 500, error: message, code: "internal_error" });

export function fromZodError(err: z.ZodError): LagoError {
  const details: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const path = issue.path.length === 0 ? "_root" : issue.path.join(".");
    if (!details[path]) details[path] = [];
    details[path].push(toLagoReason(issue));
  }
  return unprocessable("validation_errors", "Unprocessable Entity", details);
}

/**
 * Maps a Zod issue to a Lago-style reason code. Lago uses short snake_case
 * reasons (`value_already_exist`, `value_is_invalid`, `value_is_blank`,
 * `value_is_out_of_range`) inside `error_details.<field>` arrays. Anything
 * unrecognized falls through to the original Zod message — better than a
 * generic placeholder when debugging.
 */
function toLagoReason(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.message.toLowerCase().includes("required")
        ? "value_is_blank"
        : "value_is_invalid";
    case "too_small":
      return "value_is_blank";
    case "too_big":
      return "value_is_out_of_range";
    case "invalid_format":
    case "invalid_value":
      return "value_is_invalid";
    default:
      return issue.message;
  }
}

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof LagoError) {
    req.log?.warn({ err: err.toBody() }, "request_failed");
    res.status(err.status).json(err.toBody());
    return;
  }
  if (err instanceof z.ZodError) {
    const lago = fromZodError(err);
    req.log?.warn({ err: lago.toBody() }, "request_validation_failed");
    res.status(lago.status).json(lago.toBody());
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    const lago = badRequest("malformed_json", "Malformed JSON body");
    res.status(lago.status).json(lago.toBody());
    return;
  }
  req.log?.error({ err }, "unhandled_error");
  const lago = internal();
  res.status(lago.status).json(lago.toBody());
}
