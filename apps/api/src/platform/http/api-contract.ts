export type ApiMeta = Record<string, unknown>;

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  error: {
    code: string;
    message: string;
    details: unknown[];
  };
  meta?: ApiMeta;
}

export interface PaginatedMeta extends ApiMeta {
  page: number;
  page_size: number;
  total: number;
}

export const apiSuccess = <T>(data: T, meta: ApiMeta = {}): ApiSuccess<T> => ({ data, meta });

export const paginated = <T>(data: T[], page: number, pageSize: number, total: number): ApiSuccess<T[]> & { meta: PaginatedMeta } => ({
  data,
  meta: { page, page_size: pageSize, total },
});
