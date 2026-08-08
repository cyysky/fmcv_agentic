-- Distributed cron scheduler lease (Round 65): one singleton row per
-- scheduler group; replicas atomically claim/renew it, so the cron ticker
-- no longer requires a single NestJS instance.
CREATE TABLE "cron_scheduler_leases" (
    "id" TEXT NOT NULL,
    "schedulerGroup" TEXT NOT NULL DEFAULT 'default',
    "owner" TEXT NOT NULL,
    "expireAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cron_scheduler_leases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cron_scheduler_leases_schedulerGroup_key" ON "cron_scheduler_leases"("schedulerGroup");
