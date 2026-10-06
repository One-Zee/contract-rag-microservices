import type { NextFunction, Request, RequestHandler, Response } from 'express';
import Joi from 'joi';
import { type AuthContext, verifyAccessToken } from './tokens.js';

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
};

/** Errors carry the body shape the gateway answers with, so clients see no difference. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string | string[], withReason = true) {
    super(Array.isArray(message) ? message.join('; ') : message);
    this.status = status;
    this.body = withReason
      ? { message, error: REASONS[status], statusCode: status }
      : { message, statusCode: status };
  }
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof HttpError) {
    res.status(error.status).json(error.body);
    return;
  }
  // express.json() rejects a malformed body with a 400 of its own; the parser's
  // message is passed through, as Nest does.
  const status = (error as { status?: number }).status;
  if (status === 400) {
    res.status(400).json({
      message: (error as Error).message,
      error: 'Bad Request',
      statusCode: 400,
    });
    return;
  }
  console.error(error);
  res.status(500).json({ statusCode: 500, message: 'Internal server error' });
}

export const notFound: RequestHandler = (req) => {
  throw new HttpError(404, `Cannot ${req.method} ${req.path}`);
};

/** The gateway's ValidationPipe: unknown properties are rejected, every problem is listed. */
export const validateBody =
  (schema: Joi.ObjectSchema): RequestHandler =>
  (req, _res, next) => {
    const { error, value } = schema.validate(req.body ?? {}, {
      abortEarly: false,
      allowUnknown: false,
    });
    if (error) {
      throw new HttpError(
        400,
        error.details.map((detail) =>
          detail.type === 'object.unknown'
            ? `property ${detail.context?.key} should not exist`
            : detail.message,
        ),
      );
    }
    req.body = value;
    next();
  };

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.auth = verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'Unauthorized', false);
  }
  next();
};

export const requireRole =
  (role: string): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth?.roles.includes(role)) {
      throw new HttpError(403, `Required role: ${role}`);
    }
    next();
  };
