// Texts the live broker was seen answering with (read-only probes of api.binodex.app, 2026-10-02).
// A client classifies by status; these exist so a test can assert the fixture is faithful where
// it can be, and docs/mock-broker.md lists which text comes from where.
export const LIVE_MESSAGES = {
  missingBearer: 'Authentication failed: Missing bearer token',
  invalidToken: 'Authentication failed: Invalid token',
  unknownAsset: 'Unknown asset',
  startTimeRequired: 'Validation failed: "start_time" (ms epoch) is required',
  unsupportedInterval: (raw: string) =>
    `Unsupported interval ${raw}; expected "250ms" / "5s" / "1m" / "1h" / "1d" / "1w" / "1M" forms`,
  notFound: (host: string, path: string, method: string) =>
    `Sorry, the ${host}${path} HTTP method ${method} resource you are looking for was not found.`,
};

// Texts the fixture chose itself: the live answer was not observed (it needs credentials, a
// real trade or a real rate limit). The shape follows the observed `Validation failed: "code"
// is required` where one applies.
export const FIXTURE_MESSAGES = {
  required: (field: string) => `Validation failed: "${field}" is required`,
  oneOf: (field: string, values: readonly string[]) =>
    `Validation failed: "${field}" must be one of [${values.join(', ')}]`,
  positiveInteger: (field: string) => `Validation failed: "${field}" must be a positive integer`,
  nonNegativeInteger: (field: string) =>
    `Validation failed: "${field}" must be a non-negative integer`,
  amountPrecision: 'Validation failed: "amount" must have at most 2 decimal places',
  invalidJson: 'Validation failed: body is not valid JSON',
  assetUnavailable: 'Asset is not available',
  unsupportedDuration: 'Unsupported duration',
  belowMinimum: 'Amount is below the minimum',
  insufficientBalance: 'Insufficient balance',
  tooManyRequests: 'Too many requests',
  internal: 'Internal error',
  serviceUnavailable: 'Service unavailable',
  requestFailed: 'Request failed',
  closedByFixture: 'Connection closed by fixture',
};

export const brokerError = (message: string) => ({ error: { message, details: {} } });
