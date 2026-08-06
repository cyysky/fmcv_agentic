-- CreateTable
CREATE TABLE "channel_runs" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "answer" TEXT,
    "steps" INTEGER,
    "error" TEXT,
    "maxSteps" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_runs_channelId_agentName_createdAt_idx" ON "channel_runs"("channelId", "agentName", "createdAt");

-- AddForeignKey
ALTER TABLE "channel_runs" ADD CONSTRAINT "channel_runs_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
