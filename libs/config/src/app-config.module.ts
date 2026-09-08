import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ObjectSchema } from 'joi';
import { AppConfigService } from './app-config.service.js';

/**
 * Jedini ulaz za env varijable u cijelom monorepou.
 *
 * Svaki servis prosljeđuje svoju šemu — spoj `baseSchema` i fragmenata koje stvarno
 * koristi — pa se `auth-service` diže bez S3 ključeva, a `llm-service` bez
 * `DATABASE_URL`. Kompozicija namjerno živi u modulu servisa, a ne ovdje: `libs/`
 * ne smije nabrajati `apps/`.
 *
 * @example
 * imports: [AppConfigModule.forRoot(baseSchema.concat(authSchema))]
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(validationSchema: ObjectSchema): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          // Putanja se razrješava u odnosu na process.cwd(); `nest start <app>` se
          // pokreće iz korijena repoa, gdje jedan .env opslužuje sve servise.
          envFilePath: ['.env'],
          // @nestjs/config v12 validira kroz Standard Schema, pa `validationOptions`
          // više ne prima Joi opcije — moraju stajati na samoj šemi. Postavljamo ih
          // ovdje, centralno, da ih nijedan servis ne može zaboraviti:
          //   allowUnknown: true  → servis ne pada zbog varijable koju ne koristi.
          //                         Bez ovoga bi svaki servis pucao na tuđim ključevima
          //                         iz zajedničkog .env-a.
          //   abortEarly: false   → sve greške odjednom, a ne samo prva.
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
