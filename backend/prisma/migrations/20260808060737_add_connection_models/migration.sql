-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "models" TEXT[] DEFAULT ARRAY[]::TEXT[];
