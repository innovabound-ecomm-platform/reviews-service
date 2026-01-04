/**
 * Tenant utilities for reviews-service
 * Provides helpers for tenant-scoped database operations
 */

import type { Request } from "express";
import type { Prisma } from "@innovabound-ecomm-platform/reviews-db";

export function getSiteId(req: Request): string | undefined {
  return (req as { siteId?: string }).siteId;
}

export function requireSiteId(req: Request): string {
  const siteId = getSiteId(req);
  if (!siteId) {
    throw new TenantRequiredError();
  }
  return siteId;
}

interface TenantQueryOptions {
  strict?: boolean;
}

export function reviewWhere(
  siteId: string | undefined,
  additionalWhere?: Prisma.ReviewWhereInput,
  options: TenantQueryOptions = { strict: true }
): Prisma.ReviewWhereInput {
  const { strict = true } = options;
  if (strict && !siteId) {
    throw new TenantRequiredError("siteId is required for this query");
  }
  if (siteId) {
    return { ...additionalWhere, siteId };
  }
  return additionalWhere ?? {};
}

export function questionWhere(
  siteId: string | undefined,
  additionalWhere?: Prisma.QuestionWhereInput,
  options: TenantQueryOptions = { strict: true }
): Prisma.QuestionWhereInput {
  const { strict = true } = options;
  if (strict && !siteId) {
    throw new TenantRequiredError("siteId is required for this query");
  }
  if (siteId) {
    return { ...additionalWhere, siteId };
  }
  return additionalWhere ?? {};
}

export function answerWhere(
  siteId: string | undefined,
  additionalWhere?: Prisma.AnswerWhereInput,
  options: TenantQueryOptions = { strict: true }
): Prisma.AnswerWhereInput {
  const { strict = true } = options;
  if (strict && !siteId) {
    throw new TenantRequiredError("siteId is required for this query");
  }
  if (siteId) {
    return { ...additionalWhere, siteId };
  }
  return additionalWhere ?? {};
}

export function withSiteId<T extends Record<string, unknown>>(
  data: T,
  siteId: string | undefined
): T & { siteId: string } {
  if (!siteId) {
    throw new TenantRequiredError("siteId is required for create operations");
  }
  return { ...data, siteId };
}

export function validateTenantOwnership(
  recordSiteId: string | null | undefined,
  requestSiteId: string | undefined
): void {
  if (!requestSiteId) {
    throw new TenantRequiredError("Tenant context required");
  }
  if (!recordSiteId || recordSiteId !== requestSiteId) {
    throw new TenantRequiredError("Record does not belong to current tenant");
  }
}

export class TenantRequiredError extends Error {
  public readonly code = "TENANT_REQUIRED";
  public readonly statusCode = 403;
  constructor(message = "Tenant context is required for this operation") {
    super(message);
    this.name = "TenantRequiredError";
  }
}
