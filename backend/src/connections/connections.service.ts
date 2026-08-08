import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateConnectionDto,
  TestConnectionDto,
  UpdateConnectionDto,
} from './dto/connection.dto';

/** Result of a live connectivity probe against one stored connection. */
export interface ConnectionTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model: string;
  message: string;
}

@Injectable()
export class ConnectionsService {
  private readonly testTimeoutMs: number;

  constructor(private readonly prisma: PrismaService) {
    this.testTimeoutMs =
      Number(process.env.CONNECTION_TEST_TIMEOUT_MS) || 8000;
  }

  async create(dto: CreateConnectionDto): Promise<Connection> {
    const data: Prisma.ConnectionCreateInput = {
      displayName: dto.displayName,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl),
      modelName: dto.modelName,
      contextLength: dto.contextLength,
      concurrentConnections: dto.concurrentConnections,
      ...(dto.apiKey !== undefined && {
        apiKey: this.normalizeApiKey(dto.apiKey),
      }),
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
    if (dto.apiKey !== undefined) data.apiKey = this.normalizeApiKey(dto.apiKey);
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

  /**
   * Probe a stored connection over the wire: POST a one-token
   * `chat/completions` request to `baseUrl` with the stored model + key,
   * then report reachability / HTTP status / latency. The real API key is
   * used only for the probe and is never returned or logged.
   */
  async test(id: string): Promise<ConnectionTestResult> {
    const conn = await this.prisma.connection.findUnique({ where: { id } });
    if (!conn) {
      throw new NotFoundException(`Connection ${id} not found`);
    }
    return this.probe(conn.baseUrl, conn.modelName, conn.apiKey ?? undefined);
  }

  /**
   * Probe connection values that have not been persisted yet (the settings
   * form's "Test Connection" button). Same wire behavior as `test(id)` so
   * users can validate an endpoint before saving it.
   */
  async testDraft(dto: TestConnectionDto): Promise<ConnectionTestResult> {
    return this.probe(dto.baseUrl, dto.modelName, dto.apiKey);
  }

  /** Shared live probe: one-token chat/completions with bounds + graceful errors. */
  private async probe(
    baseUrl: string,
    modelName: string,
    apiKey?: string,
  ): Promise<ConnectionTestResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.testTimeoutMs);
    try {
      const response = await fetch(
        `${this.normalizeBaseUrl(baseUrl)}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        },
      );
      const latencyMs = Date.now() - started;

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          latencyMs,
          model: modelName,
          message: `Connected — ${modelName} responded.`,
        };
      }

      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300).trim();
      } catch {
        /* body unreadable; the status is still useful */
      }
      return {
        ok: false,
        status: response.status,
        latencyMs,
        model: modelName,
        message: `Upstream returned HTTP ${response.status}${
          detail ? `: ${detail}` : ''
        }`,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs,
        model: modelName,
        message: /abort/i.test(raw)
          ? `Connection timed out after ${this.testTimeoutMs} ms.`
          : `Connection failed: ${raw}`,
      };
    } finally {
      clearTimeout(timer);
    }
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

  /** Empty-string apiKey means "no key": store NULL, never an empty string. */
  private normalizeApiKey(apiKey: string): string | null {
    return apiKey === '' ? null : apiKey;
  }

  /** Mask the API key so secrets are not returned to the client. */
  private mask(conn: Connection): Connection {
    if (conn.apiKey) {
      conn.apiKey = conn.apiKey ? `${conn.apiKey.slice(0, 3)}***${conn.apiKey.slice(-3)}` : '';
    }
    return conn;
  }
}
