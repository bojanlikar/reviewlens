import Anthropic from '@anthropic-ai/sdk';
import { classifyLlmError, LlmError } from './llm.errors.js';

const api = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());

describe('classifyLlmError', () => {
  it.each([
    [401, 'authentication_error', 'invalid x-api-key', /not configured correctly/],
    [404, 'not_found_error', 'model: nope', /not configured correctly/],
    [429, 'rate_limit_error', 'too many tokens', /rate-limited/],
    [529, 'overloaded_error', 'Overloaded', /overloaded/],
    [500, 'api_error', 'boom', /overloaded/],
  ])('maps %s to a safe user message', (status, type, message, expected) => {
    const e = classifyLlmError(api(status, type, message));
    expect(e).toBeInstanceOf(LlmError);
    expect(e.userMessage).toMatch(expected);
    expect(e.message).toContain(String(status)); // detail stays in the logs
    expect(e.userMessage).not.toContain(message); // and never reaches visitors
  });

  it('treats an exhausted credit balance as a configuration problem', () => {
    const e = classifyLlmError(api(400, 'invalid_request_error', 'Your credit balance is too low'));
    expect(e.userMessage).toMatch(/not configured correctly/);
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(classifyLlmError(new Error('weird')).userMessage).toMatch(/had a problem/);
  });
});
