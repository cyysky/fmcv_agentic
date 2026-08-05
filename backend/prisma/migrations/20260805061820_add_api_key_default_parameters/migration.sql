-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "apiKey" TEXT,
ADD COLUMN     "defaultParameters" JSONB;
