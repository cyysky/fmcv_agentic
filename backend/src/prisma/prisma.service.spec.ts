import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('connects on module init and disconnects on module destroy', async () => {
    const service = new PrismaService();
    const connect = jest
      .spyOn(service, '$connect')
      .mockResolvedValue(undefined);
    const disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);
    try {
      await service.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);
      await service.onModuleDestroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
      disconnect.mockRestore();
    }
  });
});
