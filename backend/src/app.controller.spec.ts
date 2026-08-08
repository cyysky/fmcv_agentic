import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('passes through whatever the AppService returns', async () => {
      const app: TestingModule = await Test.createTestingModule({
        controllers: [AppController],
        providers: [
          { provide: AppService, useValue: { getHello: () => 'custom hello' } },
        ],
      }).compile();
      expect(app.get<AppController>(AppController).getHello()).toBe(
        'custom hello',
      );
    });
  });
});
