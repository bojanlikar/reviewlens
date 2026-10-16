import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from './api-key.guard.js';
import { LlmError } from '../llm/llm.errors.js';
import { ChatService, type IncomingMessage } from './chat.service.js';

export const MODEL_ID = 'reviewlens';

interface ChatCompletionRequest {
  model?: string;
  messages?: IncomingMessage[];
  stream?: boolean;
}

/** Minimal OpenAI-compatible surface so Open WebUI can use this app as a "model". */
@Controller('v1')
@UseGuards(ApiKeyGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chat: ChatService) {}

  @Get('models')
  models() {
    return {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'reviewlens' }],
    };
  }

  @Post('chat/completions')
  async completions(@Body() body: ChatCompletionRequest, @Res() res: Response) {
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new BadRequestException('`messages` must be a non-empty array');
    }
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;

    const errorText = (err: unknown) => {
      this.logger.error(`Chat failed: ${(err as Error).message}`);
      const user =
        err instanceof LlmError
          ? err.userMessage
          : 'Sorry, the analysis service had a problem answering that. Please try again.';
      return `\n\n⚠️ ${user}`;
    };
    this.logger.log(`Chat request stream=${!!body.stream} turns=${body.messages.length}`);

    if (body.stream) {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write(chunk({ role: 'assistant', content: '' }));
      try {
        for await (const text of this.chat.respond(body.messages)) {
          if (res.destroyed) return;
          res.write(chunk({ content: text }));
        }
      } catch (err) {
        res.write(chunk({ content: errorText(err) }));
      }
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let content = '';
    try {
      for await (const text of this.chat.respond(body.messages)) content += text;
    } catch (err) {
      content += errorText(err);
    }
    res.json({
      id,
      object: 'chat.completion',
      created,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}
