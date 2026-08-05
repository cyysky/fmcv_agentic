import { mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// E2E runs against the real Postgres but must never write into the real
// workspace volume: point AGENT_WORKSPACE_ROOT at a throwaway temp dir for
// this run. Runs before the test files load, so AppModule sees it.
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'fmcv-e2e-ws-'));
process.env.DATABASE_URL ??=
  'postgresql://fmcv:fmcv_dev_password@localhost:5432/fmcv?schema=public';
process.env.AGENT_BASE_URL ??= 'http://60.51.17.97:9999/v1';
process.env.AGENT_DEFAULT_MODEL ??= 'ds4-flash';
process.env.AGENT_API_KEY ??= '';
