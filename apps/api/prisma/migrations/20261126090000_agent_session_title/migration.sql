-- AlterTable
ALTER TABLE "agent_sessions" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "title" VARCHAR(100);

