import { Test, TestingModule } from '@nestjs/testing';
import { IngestionServiceController } from './ingestion-service.controller.js';
import { IngestionServiceService } from './ingestion-service.service.js';

describe('IngestionServiceController', () => {
  let ingestionServiceController: IngestionServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [IngestionServiceController],
      providers: [IngestionServiceService],
    }).compile();

    ingestionServiceController = app.get<IngestionServiceController>(IngestionServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(ingestionServiceController.getHello()).toBe('Hello World!');
    });
  });
});
