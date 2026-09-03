import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalServiceController } from './retrieval-service.controller.js';
import { RetrievalServiceService } from './retrieval-service.service.js';

describe('RetrievalServiceController', () => {
  let retrievalServiceController: RetrievalServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [RetrievalServiceController],
      providers: [RetrievalServiceService],
    }).compile();

    retrievalServiceController = app.get<RetrievalServiceController>(
      RetrievalServiceController,
    );
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(retrievalServiceController.getHello()).toBe('Hello World!');
    });
  });
});
