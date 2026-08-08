import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateConnectionDto,
  FetchModelsDto,
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

/** Result of fetching a provider's model list (OpenAI-compatible GET /models). */
export interface ModelListResult {
  ok: boolean;
  models: string[];
  status?: number;
  latencyMs: number;
  message: string;
  truncated?: boolean;
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
      ...(dto.models !== undefined && { models: this.normalizeModels(dto.models) }),
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
    if (dto.models !== undefined) data.models = this.normalizeModels(dto.models);

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
    const result = await this.probe(
      conn.baseUrl,
      conn.modelName,
      conn.apiKey ?? undefined,
    );
    // Persist the last-known probe so a reload of /settings still shows the
    // connection's known health (fresh row results always win in the UI).
    await this.prisma.connection.update({
      where: { id },
      data: {
        lastProbeAt: new Date(),
        lastProbeOk: result.ok,
        lastProbeStatus: result.status ?? null,
        lastProbeLatencyMs: result.latencyMs,
        lastProbeModel: result.model,
        lastProbeMessage: result.message,
      },
    });
    return result;
  }

  /**
   * Fetch the provider model list for a stored connection (GET {baseUrl}/models
   * with the stored key). Same wire behavior as `fetchModelsDraft` so the
   * Settings form can hydrate its Models textarea from known-good values.
   */
  async fetchModels(id: string): Promise<ModelListResult> {
    const conn = await this.prisma.connection.findUnique({ where: { id } });
    if (!conn) {
      throw new NotFoundException(`Connection ${id} not found`);
    }
    return this.fetchModelsFrom(conn.baseUrl, conn.apiKey ?? undefined);
  }

  /**
   * Fetch a provider model list from connection values that have not been
   * persisted yet (the Settings form's "Fetch Models" button before saving).
   */
  async fetchModelsDraft(dto: FetchModelsDto): Promise<ModelListResult> {
    return this.fetchModelsFrom(dto.baseUrl, dto.apiKey);
  }

  /**
   * Probe connection values that have not been persisted yet (the settings
   * form's "Test Connection" button). Same wire behavior as `test(id)` so
   * users can validate an endpoint before saving it.
   */
  async testDraft(dto: TestConnectionDto): Promise<ConnectionTestResult> {
    return this.probe(dto.baseUrl, dto.modelName, dto.apiKey);
  }


  /** Shared model-list fetch: GET {baseUrl}/models with bounds + graceful errors. */
  private async fetchModelsFrom(
    baseUrl: string,
    apiKey?: string,
  ): Promise<ModelListResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.testTimeoutMs);
    try {
      const response = await fetch(
        `${this.normalizeBaseUrl(baseUrl)}/models`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          signal: controller.signal,
        },
      );
      const latencyMs = Date.now() - started;

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300).trim();
        } catch {
          /* body unreadable; the status is still useful */
        }
        return {
          ok: false,
          models: [],
          status: response.status,
          latencyMs,
          message: `Upstream returned HTTP ${response.status}${
            detail ? `: ${detail}` : ''
          }`,
        };
      }

      let ids: string[] = [];
      let truncated = false;
      try {
        const parsed = (await response.json()) as {
          data?: Array<{ id?: unknown }>;
        };
        const rawIds = Array.isArray(parsed?.data)
          ? parsed.data
              .map((entry) =>
                typeof entry?.id === 'string' ? entry.id.trim() : '',
              )
              .filter((id) => id.length > 0)
          : [];
        ids = this.normalizeModels(rawIds);
        if (rawIds.length > ids.length) {
          // Raw list had duplicates/blank entries before normalization.
        }
        if (rawIds.length > 50) {
          ids = ids.slice(0, 50);
          truncated = true;
        }
      } catch {
        return {
          ok: false,
          models: [],
          status: response.status,
          latencyMs,
          message: 'Upstream returned a body that is not a JSON model list.',
        };
      }

      return {
        ok: true,
        models: ids,
        status: response.status,
        latencyMs,
        truncated,
        message: `Fetched ${ids.length} model${ids.length === 1 ? '' : 's'} from the provider.`,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        models: [],
        latencyMs,
        message: /abort/i.test(raw)
          ? `Connection timed out after ${this.testTimeoutMs} ms.`
          : `Connection failed: ${raw}`,
      };
    } finally {
      clearTimeout(timer);
    }
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

  /** Trim, drop blanks, and de-dupe the provider model list (case-insensitive,
   *  first-seen casing wins) so the picker never shows empty labels or
   *  case-variant duplicates. Empty array clears. */
  private normalizeModels(models: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of models) {
      const model = raw.trim();
      if (!model) continue;
      const key = model.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(model);
    }
    return out;
  }

  /** Mask the API key so secrets are not returned to the client. */
  private mask(conn: Connection): Connection {
    if (conn.apiKey) {
      conn.apiKey = conn.apiKey ? `${conn.apiKey.slice(0, 3)}***${conn.apiKey.slice(-3)}` : '';
    }
    return conn;
  }
}
