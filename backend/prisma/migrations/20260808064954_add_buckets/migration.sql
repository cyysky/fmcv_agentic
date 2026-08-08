-- CreateTable
CREATE TABLE "buckets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folderType" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_documents" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "buckets_name_key" ON "buckets"("name");

-- CreateIndex
CREATE INDEX "managed_documents_bucketId_idx" ON "managed_documents"("bucketId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_documents_bucketId_name_key" ON "managed_documents"("bucketId", "name");

-- AddForeignKey
ALTER TABLE "managed_documents" ADD CONSTRAINT "managed_documents_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "buckets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
