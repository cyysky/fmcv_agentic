import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConnectionDto, UpdateConnectionDto } from './dto/connection.dto';

@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateConnectionDto): Promise<Connection> {
    const data: Prisma.ConnectionCreateInput = {
      displayName: dto.displayName,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl),
      modelName: dto.modelName,
      contextLength: dto.contextLength,
      concurrentConnections: dto.concurrentConnections,
      ...(dto.apiKey !== undefined && { apiKey: dto.apiKey }),
      ...(dto.defaultParameters !== undefined && {
        defaultParameters: dto.defaultParameters as Prisma.InputJsonValue,
      }),
    };
    return this.mask(await this.prisma.connection.create({ data }));
  }

  async findAll(): Promise<Connection[]> {
    const rows = await this.prisma.connection.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.mask(r));
  }

  async findOne(id: string): Promise<Connection> {
    const conn = await this.prisma.connection.findUnique({ where: { id } });
    if (!conn) {
      throw new NotFoundException(`Connection ${id} not found`);
    }
    return this.mask(conn);
  }

  async update(id: string, dto: UpdateConnectionDto): Promise<Connection> {
    await this.ensureExists(id);

    const data: Prisma.ConnectionUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.baseUrl !== undefined) data.baseUrl = this.normalizeBaseUrl(dto.baseUrl);
    if (dto.modelName !== undefined) data.modelName = dto.modelName;
    if (dto.contextLength !== undefined) data.contextLength = dto.contextLength;
    if (dto.concurrentConnections !== undefined)
      data.concurrentConnections = dto.concurrentConnections;
    if (dto.apiKey !== undefined) data.apiKey = dto.apiKey;
    if (dto.defaultParameters !== undefined)
      data.defaultParameters = dto.defaultParameters as Prisma.InputJsonValue;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields provided to update');
    }

    const updated = await this.prisma.connection.update({ where: { id }, data });
    return this.mask(updated);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    await this.ensureExists(id);
    await this.prisma.connection.delete({ where: { id } });
    return { deleted: true };
  }

  private async ensureExists(id: string): Promise<void> {
    const count = await this.prisma.connection.count({ where: { id } });
    if (count === 0) {
      throw new NotFoundException(`Connection ${id} not found`);
    }
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  /** Mask the API key so secrets are not returned to the client. */
  private mask(conn: Connection): Connection {
    if (conn.apiKey) {
      conn.apiKey = conn.apiKey ? `${conn.apiKey.slice(0, 3)}***${conn.apiKey.slice(-3)}` : '';
    }
    return conn;
  }
}
