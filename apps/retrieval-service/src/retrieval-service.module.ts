import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  baseSchema,
  databaseSchema,
  llmSchema,
} from '@app/config';
import { RetrievalServiceController } from './retrieval-service.controller.js';
import { RetrievalServiceService } from './retrieval-service.service.js';

@Module({
  // Hibridna pretraga nad pgvectorom; treba dimenziju embeddinga za upitni vektor.
  imports: [
    AppConfigModule.forRoot(
      baseSchema.concat(databaseSchema).concat(llmSchema),
    ),
  ],
  controllers: [RetrievalServiceController],
  providers: [RetrievalServiceService],
})
export class RetrievalServiceModule {}
