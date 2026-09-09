/**
 * One error shape for the whole API:
 *
 *   { "error": { "code": "insufficient_funds", "message": "...", "details": { ... } } }
 *
 * `code` is the stable, machine-readable contract; `message` is for humans and may change.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toBody(): { error: { code: string; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'a valid bearer token is required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(409, code, message, details);
  }
}
