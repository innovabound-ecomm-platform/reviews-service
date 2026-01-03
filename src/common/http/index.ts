import { Response } from "express";

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: PaginationMeta;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function parsePageParams(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, parseInt(String(query.page || "1"), 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(query.pageSize || query.limit || "20"), 10)));
  return { page, pageSize };
}

export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> {
  const totalPages = Math.ceil(total / pageSize);
  
  return {
    success: true,
    data: items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    },
  };
}

export function success<T>(res: Response, data: T, statusCode = 200): Response {
  return res.status(statusCode).json({
    success: true,
    data,
  } as SuccessResponse<T>);
}

export function errorResponse(
  res: Response,
  message: string,
  code: string,
  statusCode: number,
  details?: Record<string, unknown>
): Response {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  } as ErrorResponse);
}
