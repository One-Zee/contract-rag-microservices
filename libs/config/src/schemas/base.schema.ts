/* oxlint-disable unicorn/no-thenable -- `then` is Joi's conditional branch, not a thenable */
import Joi from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';

export const RPC_TRANSPORTS = ['tcp', 'rmq'] as const;
export type RpcTransport = (typeof RPC_TRANSPORTS)[number];

/**
 * Variables every service validates.
 */
export const baseSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid(...Object.values(AppEnvironment))
    .default(AppEnvironment.DEVELOPMENT),

  GATEWAY_PORT: Joi.number().port().default(3000),
  AUTH_PORT: Joi.number().port().default(3001),
  AUTH_HOST: Joi.string().hostname().default('127.0.0.1'),
  INGESTION_HOST: Joi.string().hostname().default('127.0.0.1'),
  INGESTION_PORT: Joi.number().port().default(3002),
  INDEXING_PORT: Joi.number().port().default(3003),
  RETRIEVAL_HOST: Joi.string().hostname().default('127.0.0.1'),
  RETRIEVAL_PORT: Joi.number().port().default(3004),
  LLM_HOST: Joi.string().hostname().default('127.0.0.1'),
  LLM_PORT: Joi.number().port().default(3005),

  // How services call each other: Nest's TCP transport, or request/response
  // over RabbitMQ — the switch plan §9.5 measures. Every service reads it, so
  // it lives here; the hosts and ports above only matter for tcp.
  RPC_TRANSPORT: Joi.string()
    .valid(...RPC_TRANSPORTS)
    .default('tcp'),

  // Required here only for rmq. A service that publishes or consumes events
  // requires it regardless, through messagingSchema.
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .when('RPC_TRANSPORT', { is: 'rmq', then: Joi.required() }),
});
