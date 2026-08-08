-- AlterTable
ALTER TABLE "cron_jobs" ADD COLUMN     "schedulerGroup" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "cron_jobs_schedulerGroup_nextRunAt_idx" ON "cron_jobs"("schedulerGroup", "nextRunAt");
