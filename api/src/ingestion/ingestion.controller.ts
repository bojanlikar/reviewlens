import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ReviewsService } from '../reviews/reviews.service.js';
import { IngestionService } from './ingestion.service.js';

@Controller('ingestion')
export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('summary')
  summary() {
    return this.reviews.getSummary();
  }

  /** Re-run ingestion on demand (also reachable from chat via /reingest). */
  @Post('reingest')
  @HttpCode(202)
  reingest() {
    void this.ingestion.ingest();
    return { status: 'started' };
  }
}
