import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { ChatModule } from './chat/chat.module.js';
import { validateEnv } from './config/env.validation.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { LlmModule } from './llm/llm.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ReviewsModule,
    IngestionModule,
    LlmModule,
    ChatModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
