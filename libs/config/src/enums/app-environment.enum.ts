/**
 * The single source of truth for NODE_ENV — used by both the Joi schema
 * (`base.schema.ts`) and the getters (`AppConfigService.isProduction`), so the
 * two cannot drift apart.
 */
export enum AppEnvironment {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}
