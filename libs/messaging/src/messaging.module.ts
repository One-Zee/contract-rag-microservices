import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';
import { EVENT_BUS, EventPublisher } from './event-publisher.js';
import { rmqPublisherOptions } from './rmq-options.js';
import { TopologyDeclarer } from './topology-declarer.js';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: EVENT_BUS,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) =>
          rmqPublisherOptions(config.rabbitmqUrl),
      },
    ]),
  ],
  providers: [TopologyDeclarer, EventPublisher],
  exports: [EventPublisher],
})
export class MessagingModule {}
