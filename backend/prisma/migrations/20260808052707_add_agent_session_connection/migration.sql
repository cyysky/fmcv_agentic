-- AlterTable
ALTER TABLE "agent_sessions" ADD COLUMN     "connectionId" TEXT;

-- CreateIndex
CREATE INDEX "agent_sessions_connectionId_idx" ON "agent_sessions"("connectionId");

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
