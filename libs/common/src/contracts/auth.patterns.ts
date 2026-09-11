/**
 * The message contract between the gateway and `auth-service`.
 *
 * `dependency-cruiser` only sees static imports, so runtime coupling over TCP is
 * not covered by the `no-cross-app-imports` rule (ADR 002). These constants are
 * therefore the only place that coupling exists — it changes here or nowhere.
 */
export const AUTH_PATTERNS = {
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  REFRESH: 'auth.refresh',
  USER_GET: 'auth.user.get',
  USER_LIST: 'auth.user.list',
} as const;

/**
 * Every TCP call that needs an identity carries the original access token.
 *
 * `userId` is not sent as a separate field: the identity is derived from the
 * signature, so the payload cannot forge it. The field is consistently named
 * `accessToken`, and **that is an obligation** — phase 6 introduces
 * OpenTelemetry, which records RPC payloads, so this name must go on the
 * redaction list before the first Jaeger span (ADR 006).
 */
export interface AuthenticatedRpcPayload {
  accessToken: string;
}

export interface GetUserRpcPayload extends AuthenticatedRpcPayload {
  userId: string;
}
