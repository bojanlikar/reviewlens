import { Controller, Get } from '@nestjs/common';
import { ReviewsService } from './reviews/reviews.service.js';

@Controller()
export class AppController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Liveness + readiness info for Docker healthchecks. */
  @Get('health')
  health() {
    const s = this.reviews.getSummary();
    return { ok: true, ingestion: s.status, reviews: s.ingested };
  }
}
