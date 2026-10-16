import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { classifyLlmError } from './llm.errors.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client?: Anthropic;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Anthropic {
    this.client ??= new Anthropic({
      apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY'),
      // Never leave a visitor staring at a blank answer: fail instead of waiting forever.
      timeout: Number(this.config.get('LLM_TIMEOUT_MS') ?? 120_000),
      maxRetries: 1,
    });
    return this.client;
  }

  /**
   * Streams text deltas. The (large, static) system prompt carries the review
   * corpus, so it is marked cacheable: follow-up questions re-read it from the
   * prompt cache instead of paying for it again.
   */
  async *stream(system: string, messages: ChatTurn[]): AsyncGenerator<string> {
    const model =
      this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5';
    const started = Date.now();
    this.logger.log(
      `LLM request model=${model} systemChars=${system.length} turns=${messages.length}`,
    );

    let stream: ReturnType<Anthropic['messages']['stream']> | undefined;
    let completed = false;
    let textChars = 0;
    let thinkingChars = 0;
    try {
      stream = this.getClient().messages.stream({
        model,
        max_tokens: Number(this.config.get('MAX_OUTPUT_TOKENS') ?? 4096),
        system: [
          { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
        ],
        messages,
      });
      for await (const ev of stream) {
        if (ev.type !== 'content_block_delta') continue;
        const delta = ev.delta as {
          type: string;
          text?: string;
          thinking?: string;
        };
        if (delta.type === 'text_delta' && delta.text) {
          textChars += delta.text.length;
          yield delta.text;
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          thinkingChars += delta.thinking.length; // counted, never shown to visitors
        }
      }
      const final = await stream.finalMessage();
      const u = final.usage;
      completed = true;
      this.logger.log(
        `LLM done stop=${final.stop_reason} in=${u.input_tokens} out=${u.output_tokens} ` +
          `cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} ` +
          `textChars=${textChars} thinkingChars=${thinkingChars} ms=${Date.now() - started}`,
      );
      if (final.stop_reason === 'max_tokens') {
        yield '\n\n_(The answer was cut off at the length limit. Ask me to continue, or ask a narrower question.)_';
      }
    } catch (err) {
      completed = true;
      const e = classifyLlmError(err);
      this.logger.error(
        `LLM failed after ${Date.now() - started}ms: ${e.message}`,
      );
      throw e;
    } finally {
      // Consumer stopped early (e.g. the visitor closed the tab): stop paying for tokens.
      if (!completed) stream?.abort();
    }
  }
}
