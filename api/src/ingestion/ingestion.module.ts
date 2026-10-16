import { Module } from '@nestjs/common';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { IngestionController } from './ingestion.controller.js';
import { IngestionService } from './ingestion.service.js';
import { TrustpilotScraperService } from './trustpilot-scraper.service.js';
import { FileSourceService } from './file-source.service.js';
import { AppStoreSourceService } from './app-store-source.service.js';
import { SteamSourceService } from './steam-source.service.js';

@Module({
  imports: [ReviewsModule],
  controllers: [IngestionController],
  providers: [IngestionService, TrustpilotScraperService, FileSourceService, AppStoreSourceService, SteamSourceService],
  exports: [IngestionService],
})
export class IngestionModule {}
