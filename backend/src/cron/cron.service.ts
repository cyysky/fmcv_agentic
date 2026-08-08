import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CronJob, Prisma } from '@prisma/client';
import { CronExpressionParser } from 'cron-parser';
import { BaseAgentService } from '../agent/base-agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCronJobDto, UpdateCronJobDto } from './cron.dto';
import { randomUUID } from 'node:crypto';

/** Scheduler tick granularity; cron firing lands within this window. */
export const CRON_TICK_MS = 1000;
/**
 * Distributed scheduler lease (Round 65): the ticker runs only on the
 * replica that holds a fresh lease. A dead holder fails over after
 * LEASE_DURATION_MS; the lease is renewed atomically with each tick.
 */
export const CRON_LEASE_DURATION_MS = 5000;
export const CRON_LEASE_GROUP = 'default';
export const CRON_LEASE_ROW_ID = 'singleton';
/** Truncation cap for the run result stored/displayed on the job row. */
export const MAX_RUN_MESSAGE = 500;
/** Agent-turn is the only supported task right now (DIRECTION item 2). */
export const TASK_TYPE_AGENT_TURN = 'agent-turn';
/** Terminal status written by this service when a run ends. */
export const STATUS_RUNNING = 'running';
/**
 * SQL-safe "not currently running" filter. Postgres evaluates
 * `NOT ("lastRunStatus" = 'running')` as NULL on never-run rows, so Prisma's
 * plain `{ not }` filter silently excludes fresh jobs with a NULL status.
 * Match both non-running and never-run rows explicitly.
 */
const NOT_RUNNING_FILTER = {
  OR: [{ lastRunStatus: { not: STATUS_RUNNING } }, { lastRunStatus: null }],
};

/** Parse `schedule` as a 5-field cron expression and return its next
 *  occurrence strictly after `from`. Throws a BadRequestException with a
 *  clear message when the expression is invalid. */
export function nextCronRun(
  schedule: string,
  from = new Date(Date.now() + CRON_TICK_MS),
): Date {
  try {
    const parsed = CronExpressionParser.parse(schedule.trim(), {
      currentDate: from,
    });
    return parsed.next().toDate();
  } catch (err) {
    throw new BadRequestException(
      `Invalid cron schedule "${schedule}": ${(err as Error).message}`,
    );
  }
}

function truncate(text: string | undefined | null, max: number): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Recurring cron jobs (DIRECTION.md item 2).
 *
 * A job runs a scheduled agent turn (`agent-turn` task): on each firing the
 * job's prompt is sent through BaseAgentService.runTurn (with the optional
 * pinned model/connection/maxSteps) and the terminal result is persisted on
 * the row as `lastRun*`. The scheduler is an in-process ticker that checks
 * due jobs every second; `nextRunAt` and `lastRun*` survive backend
 * restarts, and jobs left "running" by a crash are marked "error" on boot.
 */
@Injectable()
export class CronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronService.name);
  private ticker: NodeJS.Timeout | null = null;
  /** Unique owner id for the distributed scheduler lease. */
  private readonly leaseOwner = randomUUID();
  /** True while this instance holds a fresh scheduler lease. */
  private leaseHeld = false;
  /** In-memory mirror of cron rows so the per-second tick never hammers the DB. */
  private readonly jobs = new Map<string, CronJob>();
  /** Per-job concurrency guard (one in-flight execution per job). */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: BaseAgentService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.cronJob
      .updateMany({
        where: { lastRunStatus: STATUS_RUNNING },
        data: {
          lastRunStatus: 'error',
          lastRunMessage: 'Interrupted by backend restart',
        },
      })
      .catch((err) => {
        this.logger.warn(
          `Could not recover interrupted cron runs: ${(err as Error).message}`,
        );
      });

    let rows: CronJob[] = [];
    try {
      rows = await this.prisma.cronJob.findMany({
        orderBy: { createdAt: 'desc' },
      });
    } catch (err) {
      this.logger.warn(
        `Could not load cron jobs on startup: ${(err as Error).message}`,
      );
    }
    for (const row of rows) {
      this.jobs.set(row.id, row);
      if (row.enabled) {
        await this.recomputeNextRun(row.id).catch((err) => {
          this.logger.warn(
            `Could not schedule cron job ${row.id}: ${(err as Error).message}`,
          );
        });
      }
    }
    this.ticker = setInterval(() => {
      void this.tick();
    }, CRON_TICK_MS);
    this.ticker.unref();
    this.leaseHeld = await this.acquireLease();
    this.logger.log(
      `Cron scheduler started: ${rows.length} job(s), ${[...this.jobs.values()].filter((j) => j.enabled).length} enabled, tick ${CRON_TICK_MS}ms, scheduler lease ${this.leaseHeld ? 'held' : 'standby'}`,
    );
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /* ------------------------------ CRUD ------------------------------ */

  async create(dto: CreateCronJobDto): Promise<CronJob> {
    const name = dto.name.trim();
    const schedule = dto.schedule.trim();
    const enabled = dto.enabled ?? true;
    nextCronRun(schedule); // validate early and clearly
    await this.assertConnection(dto.connectionId);
    const nextRunAt = enabled ? nextCronRun(schedule) : null;
    let row: CronJob;
    try {
      row = await this.prisma.cronJob.create({
        data: {
          name,
          schedule,
          taskType: dto.taskType ?? TASK_TYPE_AGENT_TURN,
          prompt: dto.prompt,
          ...(dto.model?.trim() ? { model: dto.model.trim() } : {}),
          ...(dto.connectionId ? { connectionId: dto.connectionId } : {}),
          ...(dto.maxSteps ? { maxSteps: dto.maxSteps } : {}),
          enabled,
          nextRunAt,
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`Cron job name "${name}" already exists`);
      }
      throw err;
    }
    this.jobs.set(row.id, row);
    return row;
  }

  async list(): Promise<CronJob[]> {
    return this.prisma.cronJob.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string): Promise<CronJob> {
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    this.jobs.set(row.id, row);
    return row;
  }

  async update(id: string, dto: UpdateCronJobDto): Promise<CronJob> {
    const existing = await this.get(id);
    if (!Object.values(dto).some((v) => v !== undefined)) {
      throw new BadRequestException('At least one field is required to update');
    }
    if (dto.schedule) {
      nextCronRun(dto.schedule.trim()); // validate early and clearly
    }
    const enabled = dto.enabled ?? existing.enabled;
    const scheduleChanged = dto.schedule !== undefined;
    let nextRunAt = existing.nextRunAt;
    if (dto.enabled === false) {
      nextRunAt = null;
    } else if (dto.enabled === true || (scheduleChanged && enabled)) {
      nextRunAt = nextCronRun((dto.schedule ?? existing.schedule).trim());
    }
    await this.assertConnection(dto.connectionId);
    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        schedule: dto.schedule?.trim(),
        taskType: dto.taskType,
        prompt: dto.prompt,
        model: dto.model === undefined ? undefined : dto.model.trim() || null,
        connectionId:
          dto.connectionId === undefined ? undefined : dto.connectionId || null,
        maxSteps:
          dto.maxSteps === undefined ? undefined : (dto.maxSteps ?? null),
        enabled: dto.enabled,
        nextRunAt,
      },
    });
    this.jobs.set(updated.id, updated);
    return updated;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const row = await this.get(id);
    const dbRow = await this.prisma.cronJob.findUnique({ where: { id } });
    const activeElsewhere =
      dbRow?.lastRunStatus === STATUS_RUNNING && !this.running.has(id);
    if (this.running.has(id) || activeElsewhere) {
      throw new ConflictException(
        `Cron job "${row.name}" is running; wait for it to finish before deleting`,
      );
    }
    await this.prisma.cronJob.delete({ where: { id } });
    this.jobs.delete(id);
    return { deleted: true };
  }

  /** Run a cron job immediately, outside its schedule. */
  async runNow(id: string): Promise<CronJob> {
    return this.executeJob(id);
  }

  /* ---------------------------- scheduler ---------------------------- */

  /**
   * Atomically claim/renew the distributed scheduler lease. Only one
   * replica (per schedulerGroup) gets a success per statement, so after a
   * holder dies and its lease expires a standby takes over within one tick.
   */
  private async acquireLease(): Promise<boolean> {
    const now = Date.now();
    const expireAt = new Date(now + CRON_LEASE_DURATION_MS);
    // Single atomic INSERT ... ON CONFLICT: insert the singleton row when
    // missing; otherwise renew only when we already own it or its lease has
    // expired. A replica that loses the race simply stays in standby.
    const count =
      await this.prisma.$executeRaw`
        INSERT INTO cron_scheduler_leases (id, "schedulerGroup", owner, "expireAt", "createdAt", "updatedAt")
        VALUES (${CRON_LEASE_ROW_ID}, ${CRON_LEASE_GROUP}, ${this.leaseOwner}, ${expireAt}, now(), now())
        ON CONFLICT (id) DO UPDATE SET
          owner = EXCLUDED.owner,
          "expireAt" = EXCLUDED."expireAt",
          "updatedAt" = now()
        WHERE cron_scheduler_leases.owner = EXCLUDED.owner
           OR cron_scheduler_leases."expireAt" <= now()
      `;
    return count === 1;
  }

  private async tick(): Promise<void> {
    // Only the replica holding a fresh lease fires due jobs. Standby
    // replicas keep serving CRUD/run-now and reclaim the lease on failover.
    const held = await this.acquireLease();
    if (this.leaseHeld !== held) {
      this.logger.log(
        held
          ? 'Cron scheduler lease acquired; taking over scheduled firing'
          : 'Cron scheduler lease lost; standing by',
      );
    }
    this.leaseHeld = held;
    if (!held) return;
    const now = Date.now();
    // Read the scheduler's view from the DB (multi-replica safe): the map is
    // only a cache; the DB is the source of truth for enabled/due/running.
    const due: Pick<CronJob, 'id'>[] = await this.prisma.cronJob.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: new Date(now) },
        ...NOT_RUNNING_FILTER,
      },
      select: { id: true },
    });
    for (const { id } of due) {
      this.executeJob(id).catch((err) => {
        this.logger.warn(`Could not fire cron job ${id}: ${(err as Error).message}`);
      });
    }
  }

  private async executeJob(id: string): Promise<CronJob> {
    // Same-instance guard first (no await): a second runNow/delete on this
    // replica must not even reach the DB claim while this instance runs it.
    if (this.running.has(id)) {
      throw new ConflictException('Cron job is already running');
    }
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    const claimed = await this.prisma.cronJob.updateMany({
      where: {
        id,
        ...NOT_RUNNING_FILTER,
      },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: STATUS_RUNNING,
        lastRunMessage: null,
        lastRunModel: null,
        lastRunMs: null,
      },
    });
    if (claimed.count === 0) {
      // Another replica claimed this firing (run-now or a due tick with
      // split-brain leases); never run it twice in the cluster.
      throw new ConflictException(`Cron job "${row.name}" is already running`);
    }
    this.running.add(id);
    const startedAt = Date.now();
    try {
      let result: { answer: string; model: string };
      try {
        result = await this.agent.runTurn({
          message: row.prompt,
          ...(row.model ? { model: row.model } : {}),
          ...(row.connectionId ? { connectionId: row.connectionId } : {}),
          maxSteps: row.maxSteps ?? 10,
        });
      } catch (err) {
        await this.recordResult(
          id,
          'error',
          (err as Error).message,
          undefined,
          Date.now() - startedAt,
        );
        return this.refreshed(id);
      }
      await this.recordResult(
        id,
        'done',
        result.answer,
        result.model,
        Date.now() - startedAt,
      );
      return this.refreshed(id);
    } finally {
      this.running.delete(id);
    }
  }

  /** Persist a terminal run result and slide the scheduler to the next slot. */
  private async recordResult(
    id: string,
    status: 'done' | 'error',
    message: string | undefined,
    model: string | undefined,
    ms: number,
  ): Promise<void> {
    const current = this.jobs.get(id);
    const updated = await this.prisma.cronJob.updateMany({
      where: {
        id,
        lastRunStatus: STATUS_RUNNING,
      },
      data: {
        lastRunStatus: status,
        lastRunMessage: truncate(message, MAX_RUN_MESSAGE),
        ...(model ? { lastRunModel: model } : { lastRunModel: null }),
        lastRunMs: ms,
        nextRunAt:
          current?.enabled && current.schedule
            ? nextCronRun(current.schedule)
            : null,
      },
    });
    if (updated.count === 1) {
      this.jobs.set(
        id,
        (await this.prisma.cronJob.findUnique({ where: { id } })) ??
          (current as CronJob),
      );
    }
  }

  private async refreshed(id: string): Promise<CronJob> {
    const row = await this.prisma.cronJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cron job ${id} not found`);
    this.jobs.set(row.id, row);
    return row;
  }

  private async recomputeNextRun(id: string): Promise<void> {
    const row =
      this.jobs.get(id) ??
      (await this.prisma.cronJob.findUnique({ where: { id } }));
    if (!row) return;
    const nextRunAt = row.enabled ? nextCronRun(row.schedule) : null;
    const updated = await this.prisma.cronJob.update({
      where: { id },
      data: { nextRunAt },
    });
    this.jobs.set(id, updated);
  }

  /* ---------------------------- internals ---------------------------- */

  private async assertConnection(
    connectionId: string | undefined,
  ): Promise<void> {
    if (!connectionId) return;
    const row = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!row) {
      throw new BadRequestException(`Connection ${connectionId} not found`);
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}
