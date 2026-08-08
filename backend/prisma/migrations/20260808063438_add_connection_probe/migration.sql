-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "lastProbeAt" TIMESTAMP(3),
ADD COLUMN     "lastProbeLatencyMs" INTEGER,
ADD COLUMN     "lastProbeMessage" TEXT,
ADD COLUMN     "lastProbeModel" TEXT,
ADD COLUMN     "lastProbeOk" BOOLEAN,
ADD COLUMN     "lastProbeStatus" INTEGER;
