import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { BadRequestException, ValidationError, ValidationPipe } from "@nestjs/common";
import { RequestIdMiddleware } from "./platform/http/request-id.middleware";
import { ResponseEnvelopeInterceptor } from "./platform/http/response-envelope.interceptor";
import { ApiExceptionFilter } from "./platform/http/api-exception.filter";
import { StructuredLogger } from "./platform/logging/structured-logger";
import cookieParser from "cookie-parser";
import { RequestLogMiddleware } from "./platform/http/request-log.middleware";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
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
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useLogger(new StructuredLogger());
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
