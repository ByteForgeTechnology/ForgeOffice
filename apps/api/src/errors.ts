export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have permission to perform this action') => new HttpError(403, message, 'forbidden');
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');

/** Postgres unique-violation detection across postgres.js, PGlite and Drizzle wrappers. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '23505') return true;
  }
  return false;
}
