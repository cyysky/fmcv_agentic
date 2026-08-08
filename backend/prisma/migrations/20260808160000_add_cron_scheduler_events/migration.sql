-- Scheduler lease transition audit (Round 71): append-only records of each
-- lease acquire/lose transition per scheduler group, so failover history is
-- visible even after the lease row's current ownership rolls forward.
CREATE TABLE "cron_scheduler_events" (
    "id" TEXT NOT NULL,
    "schedulerGroup" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "previousOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_scheduler_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_scheduler_events_schedulerGroup_createdAt_idx" ON "cron_scheduler_events"("schedulerGroup", "createdAt");
