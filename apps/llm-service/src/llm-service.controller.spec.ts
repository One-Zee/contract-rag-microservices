import { Test, TestingModule } from '@nestjs/testing';
import { LlmServiceController } from './llm-service.controller.js';
import { LlmServiceService } from './llm-service.service.js';

describe('LlmServiceController', () => {
  let llmServiceController: LlmServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [LlmServiceController],
      providers: [LlmServiceService],
    }).compile();

    llmServiceController = app.get<LlmServiceController>(LlmServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(llmServiceController.getHello()).toBe('Hello World!');
    });
  });
});
