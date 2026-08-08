-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "cronJobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "model" TEXT,
    "ms" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_runs_cronJobId_createdAt_idx" ON "cron_runs"("cronJobId", "createdAt");

-- AddForeignKey
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES "cron_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
