import { API_ERROR_CODES } from '@open-design/contracts';

const REQUEST_ERROR_CODES = new Set<string>([
  ...API_ERROR_CODES,
  'network_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'server_error',
  'request_failed',
  'FETCH_FAILED',
  'INVALID_ARCHIVE',
  'INVALID_MANIFEST',
]);

/** Preserve only contract-owned or explicitly enumerated operation error codes. */
export function boundedRequestErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ERROR_CODES.has(value)
    ? value
    : undefined;
}
