-- CreateEnum
CREATE TYPE "CredentialRequestStatus" AS ENUM ('PENDING', 'FULFILLED', 'DENIED', 'EXPIRED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "agent_credentials" (
    "id" TEXT NOT NULL,
    "engagement_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "encrypted_secret" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "metadata" JSONB,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,

    CONSTRAINT "agent_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_credential_requests" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_id" TEXT,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "required_scopes" TEXT[],
    "status" "CredentialRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fulfilled_at" TIMESTAMP(3),
    "fulfilled_by_id" TEXT,
    "denial_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_credential_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_credentials_engagement_id_idx" ON "agent_credentials"("engagement_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_credentials_engagement_id_scope_key" ON "agent_credentials"("engagement_id", "scope");

-- CreateIndex
CREATE INDEX "agent_credential_requests_run_id_status_idx" ON "agent_credential_requests"("run_id", "status");

-- AddForeignKey
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_credential_requests" ADD CONSTRAINT "agent_credential_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
