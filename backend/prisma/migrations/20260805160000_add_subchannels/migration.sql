-- AlterTable
ALTER TABLE "channels" ADD COLUMN "parentId" TEXT,
ADD COLUMN "agentName" TEXT;

-- CreateIndex
CREATE INDEX "channels_parentId_idx" ON "channels"("parentId");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
