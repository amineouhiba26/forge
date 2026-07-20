import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Offset pagination for list endpoints.
 *
 * Offset rather than cursor: these lists are tenant-scoped and small (a
 * freelancer has tens of clients, not millions), and offset supports the
 * jump-to-page UI this data suits. The known weakness — a deep OFFSET makes
 * Postgres walk every skipped row — does not bite at this scale. Sprint 7's
 * load test is where that assumption gets checked rather than assumed.
 */
export class PaginationQueryDto {
  /**
   * `@Type` is required: query strings arrive as strings, and `@IsInt` would
   * reject `"2"` without the transform.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /**
   * Capped deliberately. Without a maximum, `?limit=1000000` is an unauthenticated
   * way to make the database do unbounded work — a trivial denial of service.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** What a list endpoint returns. */
export interface PaginatedResult<T> {
  items: T[];
  /**
   * Total matching rows, so a client can render "page 3 of 12" rather than
   * discovering the end by hitting it.
   */
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Converts page/limit into the skip/take Prisma expects. */
export function toSkipTake(pagination: PaginationQueryDto): {
  skip: number;
  take: number;
} {
  const page = pagination.page ?? 1;
  const limit = pagination.limit ?? 20;

  return { skip: (page - 1) * limit, take: limit };
}

export function buildPaginatedResult<T>(
  items: T[],
  total: number,
  pagination: PaginationQueryDto,
): PaginatedResult<T> {
  const page = pagination.page ?? 1;
  const limit = pagination.limit ?? 20;

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
