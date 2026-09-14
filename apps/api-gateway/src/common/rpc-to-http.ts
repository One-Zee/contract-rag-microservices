import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import {
  type Observable,
  type OperatorFunction,
  catchError,
  throwError,
} from 'rxjs';
import type { RpcErrorShape } from '@app/common';

const logger = new Logger('RpcToHttp');

const isRpcErrorShape = (value: unknown): value is RpcErrorShape =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RpcErrorShape).statusCode === 'number' &&
  typeof (value as RpcErrorShape).message === 'string';

/**
 * Translates an error from TCP back into an HTTP response.
 *
 * Without this every error from `auth-service` reaches the client as a 500.
 */
export function rpcToHttp<T>(): OperatorFunction<T, T> {
  return catchError<T, Observable<never>>((error: unknown) => {
    if (isRpcErrorShape(error)) {
      return throwError(
        () =>
          new HttpException(
            {
              statusCode: error.statusCode,
              message: error.message,
              error: error.error,
            },
            error.statusCode,
          ),
      );
    }

    logger.error(
      `Unexpected error on TCP call: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return throwError(
      () =>
        new HttpException(
          'The authentication service is currently unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        ),
    );
  });
}
