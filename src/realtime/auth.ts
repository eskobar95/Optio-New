/**
 * Connect auth port — short-lived token at connect; no secrets hardcoded (ENG-40).
 */
export interface AuthClaims {
  subject: string;
  expiresAt?: number;
}

export interface AuthPort {
  /**
   * Validate a connect token (query or first auth frame).
   * Reject with status 401 to stop client reconnect.
   */
  verify(token: string, now?: number): Promise<AuthClaims> | AuthClaims;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 401, code = "unauthorized") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/** Test double: accepts any non-empty token equal to `expected`. */
export class StaticTokenAuth implements AuthPort {
  constructor(
    private readonly expected: string,
    private readonly subject = "test-user",
  ) {}

  verify(token: string): AuthClaims {
    if (token !== this.expected) {
      throw new AuthError("invalid token", 401);
    }
    return { subject: this.subject };
  }
}

/** Open auth for local unit tests that do not exercise auth. */
export class AllowAllAuth implements AuthPort {
  verify(_token: string): AuthClaims {
    return { subject: "anonymous" };
  }
}
