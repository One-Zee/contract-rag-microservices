/**
 * Jedini izvor istine za NODE_ENV — koriste ga i Joi šema (`base.schema.ts`)
 * i geteri (`AppConfigService.isProduction`), pa se vrijednosti ne mogu razići.
 */
export enum AppEnvironment {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
  TEST = 'test',
}
