import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe } from "@nestjs/common";
import { RequestIdMiddleware } from "./platform/http/request-id.middleware";
import { ResponseEnvelopeInterceptor } from "./platform/http/response-envelope.interceptor";
import { ApiExceptionFilter } from "./platform/http/api-exception.filter";
import { StructuredLogger } from "./platform/logging/structured-logger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix("api/v1");
  app.enableCors();
  app.use(new RequestIdMiddleware().use);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useLogger(new StructuredLogger());
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
