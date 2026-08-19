import { ConsoleLogger } from "@nestjs/common";

export class StructuredLogger extends ConsoleLogger {
  override log(message: unknown, context?: string) {
    super.log(JSON.stringify({ level: "info", message, context, timestamp: new Date().toISOString() }));
  }

  override error(message: unknown, stack?: string, context?: string) {
    super.error(JSON.stringify({ level: "error", message, context, stack, timestamp: new Date().toISOString() }));
  }
}
