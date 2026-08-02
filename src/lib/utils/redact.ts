export const REDACTED = '***REDACTED***';

const SENSITIVE_KEYS = ['apiKey', 'key', 'password', 'secret', 'token'];

export const redactConfig = (
  config: Record<string, any>,
): Record<string, any> => {
  const redacted: Record<string, any> = {};

  for (const [k, v] of Object.entries(config)) {
    redacted[k] = SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))
      ? REDACTED
      : v;
  }

  return redacted;
};

export const redactProviderConfig = <T extends { config: Record<string, any> }>(
  provider: T,
): T => {
  return {
    ...provider,
    config: redactConfig(provider.config),
  };
};
