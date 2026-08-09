import type { BaseTool } from '../agent/base-agent.service';
import type { SkillsService } from './skills.service';
import { MAX_SKILL_CONTENT, SKILL_NAME_RE } from './skills.dto';

/** Agent-facing skill management tools (DIRECTION item 2). Agents can list,
 *  read (`read_skill`, registered by the base agent), create, update, and
 *  delete reusable skill files from inside the loop — same validation rules
 *  as the human /skills CRUD API (slug names, content cap). */
export function buildSkillTools(skills: SkillsService): BaseTool[] {
  return [
    {
      name: 'list_skills',
      description:
        'List all authored skills (id, name, description, installed, ' +
        'createdAt/updatedAt), installed or not. args: {} (no arguments).',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async () => skills.list(),
    },
    {
      name: 'create_skill',
      description:
        'Create a new skill: a slug name plus optional description, markdown ' +
        'content, and installed flag. Content is required before installing. ' +
        'args: { name, description?, content?, installed? }.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Unique slug name: 1-64 chars, letters/digits/dash/underscore.',
          },
          description: {
            type: 'string',
            description: 'Optional (max 300 chars).',
          },
          content: {
            type: 'string',
            description:
              'Optional markdown instructions (SKILL.md body), max 200k chars.',
          },
          installed: {
            type: 'boolean',
            description: 'Optional; requires non-empty content to install.',
          },
        },
        required: ['name'],
      },
      run: async (args: Record<string, unknown>) =>
        skills.create({
          name: validateName(args.name),
          description: optionalString(args, 'description', 300),
          content: optionalString(args, 'content', MAX_SKILL_CONTENT),
          installed: optionalBool(args, 'installed'),
        }),
    },
    {
      name: 'update_skill',
      description:
        'Update any subset of a skill by id: name, description, content, ' +
        'installed. args: { id, ... }.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id (uuid).' },
          name: { type: 'string', description: 'New slug name (optional).' },
          description: { type: 'string' },
          content: { type: 'string' },
          installed: { type: 'boolean' },
        },
        required: ['id'],
      },
      run: async (args: Record<string, unknown>) => {
        const id = argString(args, 'id');
        const dto: Record<string, unknown> = {};
        const name = args.name;
        if (name !== undefined) dto.name = validateName(name);
        const description = optionalString(args, 'description', 300);
        if (description !== undefined) dto.description = description;
        const content = optionalString(args, 'content', MAX_SKILL_CONTENT);
        if (content !== undefined) dto.content = content;
        const installed = optionalBool(args, 'installed');
        if (installed !== undefined) dto.installed = installed;
        if (Object.keys(dto).length === 0) {
          throw new Error('At least one field is required to update');
        }
        return skills.update(id, dto);
      },
    },
    {
      name: 'delete_skill',
      description:
        'Delete a skill by id (removes the authored record; installed agents ' +
        'lose it immediately). args: { id: string }.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Skill id (uuid).' } },
        required: ['id'],
      },
      run: async (args: Record<string, unknown>) =>
        skills.delete(argString(args, 'id')),
    },
  ];
}

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  if (t.length > max) throw new Error(`${key} must be at most ${max} chars`);
  return t;
}

function optionalBool(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'off'].includes(t)) return false;
  }
  return undefined;
}

function validateName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      'name must start with a letter or digit and use letters, digits, dash or underscore only (max 64 chars)',
    );
  }
  return name;
}
