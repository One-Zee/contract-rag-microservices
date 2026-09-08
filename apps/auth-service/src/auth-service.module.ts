import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  authSchema,
  baseSchema,
  databaseSchema,
} from '@app/config';
import { AuthServiceController } from './auth-service.controller.js';
import { AuthServiceService } from './auth-service.service.js';

@Module({
  // Izdaje i rotira tokene, čita korisnike iz baze.
  imports: [
    AppConfigModule.forRoot(
      baseSchema.concat(authSchema).concat(databaseSchema),
    ),
  ],
  controllers: [AuthServiceController],
  providers: [AuthServiceService],
})
export class AuthServiceModule {}
