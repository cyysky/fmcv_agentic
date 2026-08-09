import type { BaseTool } from '../agent/base-agent.service';
import type { CronService } from './cron.service';

/**
 * Agent-facing cron management tools (DIRECTION item 3).
 *
 * Agents manage recurring jobs through the same native NestJS cron service
 * humans use on /cron: list existing jobs, create/update/delete them, and
 * trigger a manual "run now". Every mutation goes through CronService's
 * validation, DB persistence, atomic row claims and distributed scheduler
 * lease — no system cron / host crontab is ever involved.
 */

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isInteger(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off'].includes(t)) return false;
  }
  return undefined;
}

/** Build the cron tools an agent can call inside its loop. */
export function buildCronTools(cron: CronService): BaseTool[] {
  return [
    {
      name: 'list_cron_jobs',
      description:
        'List all scheduled cron jobs (id, name, schedule, prompt, enabled, ' +
        'model, maxSteps, nextRunAt, lastRun status). args: {} (no arguments).',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async () => cron.list(),
    },
    {
      name: 'create_cron_job',
      description:
        'Create a recurring agent-turn cron job. args: { name, schedule ' +
        '(5-field cron: minute hour day-of-month month day-of-week), prompt, ' +
        "model?, connectionId?, maxSteps?, enabled? }.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique job name.' },
          schedule: {
            type: 'string',
            description:
              'Five-field cron expression, e.g. "*/15 * * * *".',
          },
          prompt: {
            type: 'string',
            description: 'The agent-turn prompt the job runs.',
          },
          model: {
            type: 'string',
            description: 'Optional catalog model id (e.g. ds4-flash).',
          },
          connectionId: {
            type: 'string',
            description: 'Optional saved connection id (uuid).',
          },
          maxSteps: {
            type: 'integer',
            description: 'Optional agent step budget (1-20, default 10).',
          },
          enabled: {
            type: 'boolean',
            description: 'Optional; defaults to true.',
          },
        },
        required: ['name', 'schedule', 'prompt'],
      },
      run: async (args: Record<string, unknown>) => {
        return cron.create({
          name: argString(args, 'name'),
          schedule: argString(args, 'schedule'),
          prompt: argString(args, 'prompt'),
          taskType: 'agent-turn',
          model: optionalString(args, 'model'),
          connectionId: optionalString(args, 'connectionId'),
          maxSteps: optionalInt(args, 'maxSteps'),
          enabled: optionalBool(args, 'enabled'),
        });
      },
    },
    {
      name: 'update_cron_job',
      description:
        'Update any subset of a cron job by id: name, schedule, prompt, ' +
        'model, connectionId, maxSteps, enabled. args: { id, ... }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Cron job id (uuid).' },
          name: { type: 'string' },
          schedule: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string' },
          connectionId: { type: 'string' },
          maxSteps: { type: 'integer' },
          enabled: { type: 'boolean' },
        },
        required: ['id'],
      },
      run: async (args: Record<string, unknown>) => {
        const dto: Record<string, unknown> = {};
        for (const key of [
          'name',
          'schedule',
          'prompt',
          'model',
          'connectionId',
          'maxSteps',
          'enabled',
        ] as const) {
          if (args[key] === undefined) continue;
          if (key === 'model' || key === 'connectionId') {
            const v = typeof args[key] === 'string' ? args[key].trim() : args[key];
            if (v !== '') dto[key] = v;
            continue;
          }
          if (key === 'maxSteps') {
            const n = optionalInt(args, key);
            if (n !== undefined) dto[key] = n;
            continue;
          }
          if (key === 'enabled') {
            const b = optionalBool(args, key);
            if (b !== undefined) dto[key] = b;
            continue;
          }
          dto[key] = args[key];
        }
        return cron.update(argString(args, 'id'), dto as never);
      },
    },
    {
      name: 'delete_cron_job',
      description:
        'Delete a scheduled cron job by id. Fails while the job is running. ' +
        'args: { id: string }.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: async (args: Record<string, unknown>) =>
        cron.delete(argString(args, 'id')),
    },
    {
      name: 'run_cron_job_now',
      description:
        'Run a cron job immediately, outside its schedule (waits for the ' +
        'agent turn to finish). args: { id: string }.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: async (args: Record<string, unknown>) =>
        cron.runNow(argString(args, 'id')),
    },
  ];
}
