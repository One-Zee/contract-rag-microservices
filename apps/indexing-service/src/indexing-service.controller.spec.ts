import { Test, TestingModule } from '@nestjs/testing';
import { IndexingServiceController } from './indexing-service.controller.js';
import { IndexingServiceService } from './indexing-service.service.js';

describe('IndexingServiceController', () => {
  let indexingServiceController: IndexingServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [IndexingServiceController],
      providers: [IndexingServiceService],
    }).compile();

    indexingServiceController = app.get<IndexingServiceController>(IndexingServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(indexingServiceController.getHello()).toBe('Hello World!');
    });
  });
});
