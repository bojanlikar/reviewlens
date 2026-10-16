/** Fail fast at boot if required configuration is missing or malformed. */
export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  const missing: string[] = [];
  if (!env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!env.REVIEW_SOURCE_URL && !env.REVIEW_SOURCE_FILE) {
    missing.push('REVIEW_SOURCE_URL (or REVIEW_SOURCE_FILE)');
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return env;
}
