import { IsNotEmpty, IsString, IsUUID } from "class-validator";

/**
 * POST /business-query/sessions/:id/runs 的请求体（模块设计「API 权限与数据表」）。
 *
 * `question` 是非空字符串即可：R-6 明确**不按 token 数或字符数另设产品配额**，
 * 这里刻意不放 @Length 上限 —— 长问题由 DeepSeek 自身窗口限制兜底（超窗是明确错误，不是静默截断）。
 */
export class CreateRunDto {
  @IsString({ message: "question 必须是字符串" })
  @IsNotEmpty({ message: "question 不能为空" })
  question!: string;

  @IsUUID(undefined, { message: "client_message_id 必须是 UUID" })
  client_message_id!: string;
}
