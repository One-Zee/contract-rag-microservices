import { RpcException } from '@nestjs/microservices';

/**
 * The shape a service throws through `RpcException`, which the gateway
 * translates back into an HTTP status (`rpcToHttp`).
 *
 * Without an agreed shape the gateway cannot tell 401 from 409, so everything
 * becomes a 500 — and the client loses the only information it can act on.
 */
export interface RpcErrorShape {
  statusCode: number;
  message: string;
  error: string;
}

export const rpcError = (
  statusCode: number,
  message: string,
  error: string,
): RpcException =>
  new RpcException({ statusCode, message, error } satisfies RpcErrorShape);

export const rpcBadRequest = (message: string) =>
  rpcError(400, message, 'Bad Request');

export const rpcUnauthorized = (message: string) =>
  rpcError(401, message, 'Unauthorized');

export const rpcForbidden = (message: string) =>
  rpcError(403, message, 'Forbidden');

export const rpcNotFound = (message: string) =>
  rpcError(404, message, 'Not Found');

export const rpcConflict = (message: string) =>
  rpcError(409, message, 'Conflict');

export const rpcPayloadTooLarge = (message: string) =>
  rpcError(413, message, 'Payload Too Large');

export const rpcUnsupportedMediaType = (message: string) =>
  rpcError(415, message, 'Unsupported Media Type');
