import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [ReviewsModule, LlmModule, IngestionModule],
  controllers: [ChatController],
  providers: [ChatService, ApiKeyGuard],
})
export class ChatModule {}
