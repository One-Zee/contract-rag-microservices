import {
  type ExecutionContext,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';

/**
 * Returns the raw Bearer token from the header so the controller can forward it
 * to the service.
 */
export const AccessToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    return token;
  },
);
