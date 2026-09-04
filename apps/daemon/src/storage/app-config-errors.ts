export class InvalidAppConfigValueError extends Error {
  readonly code = 'INVALID_APP_CONFIG_VALUE';

  constructor(public readonly key: string, message: string) {
    super(message);
    this.name = 'InvalidAppConfigValueError';
  }
}
