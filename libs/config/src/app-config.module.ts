import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ObjectSchema } from 'joi';
import { AppConfigService } from './app-config.service.js';

/**
 * The single entry point for environment variables across the monorepo.
 *
 * Each service passes its own schema — `baseSchema` composed with the fragments
 * it actually uses — so `auth-service` boots without S3 keys and `api-gateway`
 * boots without `DATABASE_URL`. The composition deliberately lives in the
 * service's module rather than here: `libs/` must not enumerate `apps/`.
 *
 * @example
 * imports: [AppConfigModule.forRoot(baseSchema.concat(authSchema))]
 */
@Global()
@Module({})
export class AppConfigModule {
  private static processSchema: ObjectSchema | undefined;

  /**
   * For a process that composes several services' root modules — the
   * monolith — and must be called before those modules are imported.
   *
   * Each root module calls `forRoot` with its own fragments, but
   * `@nestjs/config` keeps a single validated configuration per process, and
   * every `forRoot` overwrites it: whichever module loads last decides how
   * every value is typed. With a process schema, every call validates the same
   * complete schema, so the order stops mattering. A service never calls this.
   */
  static useProcessSchema(schema: ObjectSchema): void {
    AppConfigModule.processSchema = schema;
  }

  static forRoot(serviceSchema: ObjectSchema): DynamicModule {
    const validationSchema = AppConfigModule.processSchema ?? serviceSchema;
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          // Resolved relative to process.cwd(); `nest start <app>` runs from the
          // repo root, where a single .env serves every service.
          envFilePath: ['.env'],
          // @nestjs/config v12 validates through Standard Schema, so
          // `validationOptions` no longer accepts Joi options — they must sit on
          // the schema itself. Set centrally here so no service can forget them:
          //   allowUnknown: true  → a service does not fail over a variable it
          //                         does not use. Without it every service would
          //                         choke on the others' keys in the shared .env.
          //   abortEarly: false   → report all errors at once, not just the first.
          validationSchema: validationSchema.options({
            abortEarly: false,
            allowUnknown: true,
          }),
          cache: true,
        }),
      ],
      providers: [AppConfigService],
      exports: [AppConfigService],
    };
  }
}
