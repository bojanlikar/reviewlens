import { Module } from '@nestjs/common';
import { FileSnapshotRepository } from './file-snapshot.repository.js';
import { ReviewRepository } from './review.repository.js';
import { ReviewsService } from './reviews.service.js';

@Module({
  providers: [
    ReviewsService,
    // Swap this binding to move persistence to e.g. Postgres.
    { provide: ReviewRepository, useClass: FileSnapshotRepository },
  ],
  exports: [ReviewsService],
})
export class ReviewsModule {}
