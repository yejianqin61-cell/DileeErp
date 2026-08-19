import type { NextFunction, Request, Response } from "express";

export class RequestLogMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const startedAt = performance.now();
    response.once("finish", () => {
      console.log(JSON.stringify({ level: "info", event: "http_request", method: request.method, path: request.originalUrl, status: response.statusCode, duration_ms: Math.round(performance.now() - startedAt), request_id: response.getHeader("x-request-id"), timestamp: new Date().toISOString() }));
    });
    next();
  }
}
