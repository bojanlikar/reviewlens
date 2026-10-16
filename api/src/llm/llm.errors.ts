import Anthropic from '@anthropic-ai/sdk';

/**
 * An LLM failure with two audiences: `message` is detailed and goes to the
 * server logs; `userMessage` is safe to show to portal visitors (no secrets,
 * no configuration details).
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const CONFIG = 'The analysis service is not configured correctly. Please tell the site owner (details are in the server logs).';
const BUSY = 'The analysis service is rate-limited right now. Please try again in a minute.';
const OVERLOADED = 'The AI provider is temporarily overloaded. Please try again shortly.';
const TIMEOUT = 'The analysis took too long and was cancelled. Please try again.';
const GENERIC = 'Sorry, the analysis service had a problem answering that. Please try again.';

export function classifyLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const detail = err instanceof Error ? err.message : String(err);

  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError(`timeout: ${detail}`, TIMEOUT);
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    const tag = `${s ?? 'no-status'} ${(err.error as any)?.error?.type ?? ''} ${detail}`.trim();
    if (s === 401 || s === 403 || s === 404) return new LlmError(tag, CONFIG);
    if (s === 400 && /credit balance/i.test(detail)) return new LlmError(tag, CONFIG);
    if (s === 429) return new LlmError(tag, BUSY);
    if (s === 529 || (s !== undefined && s >= 500)) return new LlmError(tag, OVERLOADED);
    return new LlmError(tag, GENERIC);
  }
  return new LlmError(detail, GENERIC);
}
