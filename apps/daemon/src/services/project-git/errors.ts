import type { ApiErrorCode, JsonValue } from '@open-design/contracts';

/** Safe domain boundary: never attach Git stderr, credentials, or environment values. */
export class GitDomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, JsonValue>,
  ) {
    super(message);
    this.name = 'GitDomainError';
  }
}
