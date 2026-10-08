import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ClientProxy, RmqRecordBuilder } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import type { DomainEvent } from '@app/common';

export const EVENT_BUS = 'EVENT_BUS';

@Injectable()
export class EventPublisher implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventPublisher.name);

  constructor(@Inject(EVENT_BUS) private readonly client: ClientProxy) {}

  /**
   * Connect at boot rather than on the first publish, so a wrong URL fails
   * the service the same way a missing environment variable does — and not
   * minutes later, inside the first upload.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Resolves only once the broker has confirmed the message (Nest's RMQ client
   * publishes on a confirm channel and settles `emit` from its callback), so a
   * caller that awaits this may treat the event as delivered to the queue.
   *
   * The event id doubles as the AMQP `messageId` — a consumer that sees the
   * same id twice (redelivery after a crash) can skip the second one.
   */
  async publish<TEvent extends DomainEvent>(event: TEvent): Promise<void> {
    const record = new RmqRecordBuilder(event)
      .setOptions({
        messageId: event.eventId,
        contentType: 'application/json',
        // AMQP timestamps are seconds since the epoch, not milliseconds.
        timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        persistent: true,
      })
      .build();

    await lastValueFrom(this.client.emit(event.type, record), {
      defaultValue: undefined,
    });
    this.logger.debug(`Published ${event.type} (${event.eventId})`);
  }
}
