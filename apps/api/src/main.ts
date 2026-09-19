import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { BadRequestException, ValidationError, ValidationPipe } from "@nestjs/common";
import { RequestIdMiddleware } from "./platform/http/request-id.middleware";
import { ResponseEnvelopeInterceptor } from "./platform/http/response-envelope.interceptor";
import { AuditActorInterceptor } from "./platform/audit/audit-actor.interceptor";
import { AuditActorService } from "./platform/audit/audit-actor.service";
import { ApiExceptionFilter } from "./platform/http/api-exception.filter";
import { StructuredLogger } from "./platform/logging/structured-logger";
import cookieParser from "cookie-parser";
import { RequestLogMiddleware } from "./platform/http/request-log.middleware";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.getHttpAdapter().getInstance().disable("etag");
  app.setGlobalPrefix("api/v1");
  app.enableCors();
  app.use(cookieParser());
  app.use(new RequestIdMiddleware().use);
  app.use(new RequestLogMiddleware().use);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) => new BadRequestException({
      code: "VALIDATION_ERROR",
      message: "请求参数校验失败",
      details: errors.flatMap((error) => Object.entries(error.constraints ?? {}).map(([rule, message]) => ({ field: error.property, rule, message }))),
    }),
  }));
  // 顺序不影响结果：AuditActorInterceptor 同时认「裸返回值」与「已包信封」两种形态。
  // 它按页一次性把 createdBy/updatedBy 解析成姓名（`created_by_name` / `updated_by_name`），
  // 这样全站列表/详情都能显示「创建人 / 最后修改人」，而业务 service 不必知道界面要显示谁。
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(), new AuditActorInterceptor(app.get(AuditActorService)));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useLogger(new StructuredLogger());
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
