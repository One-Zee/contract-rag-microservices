import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { MulterModule } from '@nestjs/platform-express';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  AppConfigModule,
  AppConfigService,
  authSchema,
  baseSchema,
  throttleSchema,
  uploadSchema,
} from '@app/config';
import { TelemetryModule } from '@app/telemetry';
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
import { HttpThrottlerGuard } from './throttling/http-throttler.guard.js';
import { createThrottlerOptions } from './throttling/throttling.options.js';
import { UsersController } from './users/users.controller.js';

@Module({
  imports: [
    AppConfigModule.forRoot(
      baseSchema.concat(authSchema).concat(uploadSchema).concat(throttleSchema),
    ),
    TelemetryModule,
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: createThrottlerOptions,
    }),
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
  providers: [
    JwtStrategy,
    // Global, so it runs before every controller's own guards: a request over
    // budget is refused before its token is even verified (ADR 022).
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
  ],
})
export class ApiGatewayModule {}
