import { HttpException, HttpStatus } from "@nestjs/common";

export type ApiErrorDetail = Record<string, unknown>;

export class ApiError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details: ApiErrorDetail[] = []) {
    super({ code, message, details }, status);
  }
}
