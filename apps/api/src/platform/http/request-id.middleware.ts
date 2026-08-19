import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export class RequestIdMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const requestId = request.header("x-request-id") || randomUUID();
    response.setHeader("x-request-id", requestId);
    (request as Request & { requestId?: string }).requestId = requestId;
    next();
  }
}
