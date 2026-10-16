import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { LlmService, type ChatTurn } from '../llm/llm.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { formatSummaryMarkdown } from '../reviews/summary.format.js';
import { buildSystemPrompt } from './system-prompt.js';

export interface IncomingMessage {
  role?: string;
  content?: unknown;
}

const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 4000;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly reviews: ReviewsService,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * Normalises whatever the client sent. Client-supplied system messages are
   * dropped on purpose: only this server decides the system prompt.
   */
  static sanitize(messages: IncomingMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = ChatService.flatten(m.content).trim().slice(0, MAX_MESSAGE_CHARS);
      if (!content) continue;
      const last = turns[turns.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${content}`;
      else turns.push({ role: m.role, content });
    }
    const recent = turns.slice(-MAX_TURNS);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    return recent;
  }

  private static flatten(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && typeof p === 'object' && (p as any).type === 'text' ? String((p as any).text ?? '') : ''))
        .join('\n');
    }
    return '';
  }

  async *respond(messages: IncomingMessage[]): AsyncGenerator<string> {
    const turns = ChatService.sanitize(messages);
    const last = turns[turns.length - 1];
    if (!last) {
      yield 'Ask me a question about the ingested reviews, or type `/summary` to see what was collected.';
      return;
    }

    const command = last.content.toLowerCase();
    if (command === '/summary') {
      yield formatSummaryMarkdown(this.reviews.getSummary());
      return;
    }
    if (command === '/reingest') {
      void this.ingestion.ingest();
      yield '🔄 Re-ingestion started. Type `/summary` in a few seconds to see the result.';
      return;
    }

    const summary = this.reviews.getSummary();
    if (summary.status !== 'ready') {
      yield formatSummaryMarkdown(summary);
      return;
    }

    const system = buildSystemPrompt({
      summary,
      reviews: this.reviews.getReviews(),
      maxContextChars: Number(this.config.get('MAX_CONTEXT_CHARS') ?? 350_000),
    });
    let produced = false;
    for await (const text of this.llm.stream(system, turns)) {
      if (text) produced = true;
      yield text;
    }
    if (!produced) {
      this.logger.warn('The model returned no text');
      yield 'The model returned an empty answer. Please try rephrasing your question.';
    }
  }
}
