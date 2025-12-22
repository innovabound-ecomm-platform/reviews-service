import { z } from 'zod';

// Enums matching Prisma schema
export const ReviewStatusEnum = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'FLAGGED',
  'REMOVED',
]);

export const ModerationActionEnum = z.enum([
  'APPROVE',
  'REJECT',
  'FLAG',
  'REMOVE',
  'RESTORE',
]);

export const ReportReasonEnum = z.enum([
  'SPAM',
  'INAPPROPRIATE',
  'FAKE',
  'HARASSMENT',
  'OFF_TOPIC',
  'OTHER',
]);

export const VoteTypeEnum = z.enum([
  'HELPFUL',
  'NOT_HELPFUL',
]);

export const QuestionStatusEnum = z.enum([
  'OPEN',
  'ANSWERED',
  'CLOSED',
]);

export const VerificationMethodEnum = z.enum([
  'ORDER_MATCH',
  'RECEIPT_UPLOAD',
  'EXTERNAL_IMPORT',
  'MANUAL',
]);

// Review schemas
export const createReviewSchema = z.object({
  productId: z.string().min(1),
  productVariantId: z.string().optional(),
  displayName: z.string().min(1).max(100),
  title: z.string().max(200).optional(),
  body: z.string().min(10).max(5000),
  rating: z.number().int().min(10).max(50), // 10-50 for half-star support
  orderId: z.string().optional(), // For verified purchase
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
});

export const updateReviewSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(10).max(5000).optional(),
  rating: z.number().int().min(10).max(50).optional(),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
});

export const reviewQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: ReviewStatusEnum.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  verifiedOnly: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  sortBy: z.enum(['newest', 'oldest', 'highest', 'lowest', 'helpful']).default('newest'),
});

// Review image schemas
export const addImageSchema = z.object({
  url: z.string().url(),
  altText: z.string().max(255).optional(),
  sortOrder: z.number().int().min(0).default(0),
});

// Vote schemas
export const voteSchema = z.object({
  voteType: VoteTypeEnum,
});

// Report schemas
export const createReportSchema = z.object({
  reason: ReportReasonEnum,
  details: z.string().max(1000).optional(),
});

export const resolveReportSchema = z.object({
  action: z.enum(['dismiss', 'remove_review', 'flag_review']),
});

// Vendor response schemas
export const vendorResponseSchema = z.object({
  body: z.string().min(10).max(2000),
});

// Moderation schemas
export const moderationActionSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const moderationQueueQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: ReviewStatusEnum.optional(),
});

// Question schemas
export const createQuestionSchema = z.object({
  productId: z.string().min(1),
  displayName: z.string().min(1).max(100),
  body: z.string().min(10).max(2000),
});

export const updateQuestionSchema = z.object({
  body: z.string().min(10).max(2000),
});

export const questionQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: QuestionStatusEnum.optional(),
  sortBy: z.enum(['newest', 'oldest', 'popular']).default('newest'),
});

// Answer schemas
export const createAnswerSchema = z.object({
  displayName: z.string().min(1).max(100),
  body: z.string().min(10).max(2000),
  isVendor: z.boolean().default(false),
});

export const updateAnswerSchema = z.object({
  body: z.string().min(10).max(2000),
});

// Verification schemas
export const verifyReviewSchema = z.object({
  method: VerificationMethodEnum,
  orderId: z.string().optional(),
  orderItemId: z.string().optional(),
  purchasedAt: z.coerce.date().optional(),
  receiptUrl: z.string().url().optional(),
  externalSource: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});
