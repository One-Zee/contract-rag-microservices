import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { MulterModule } from '@nestjs/platform-express';
import {
  AppConfigModule,
  AppConfigService,
  authSchema,
  baseSchema,
  uploadSchema,
} from '@app/config';
import { HealthController } from './api-gateway.controller.js';
import { AuthClientModule } from './clients/auth-client.module.js';
import { IngestionClientModule } from './clients/ingestion-client.module.js';
import { LlmClientModule } from './clients/llm-client.module.js';
import { AuthController } from './auth/auth.controller.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { DocumentsController } from './documents/documents.controller.js';
import { createUploadOptions } from './documents/upload.options.js';
import { RetrievalClientModule } from './clients/retrieval-client.module.js';
import { QueryController } from './query/query.controller.js';
import { SearchController } from './search/search.controller.js';
import { UsersController } from './users/users.controller.js';

@Module({
  imports: [
    AppConfigModule.forRoot(baseSchema.concat(authSchema).concat(uploadSchema)),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // Decorator options are fixed at class-definition time; the size limit
    // comes from the environment, so it enters through the module instead.
    MulterModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: createUploadOptions,
    }),
    AuthClientModule,
    IngestionClientModule,
    RetrievalClientModule,
    LlmClientModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    DocumentsController,
    SearchController,
    QueryController,
  ],
  providers: [JwtStrategy],
})
export class ApiGatewayModule {}
