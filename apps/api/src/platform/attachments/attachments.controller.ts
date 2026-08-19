import { Body, Controller, Delete, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsString, IsUUID, MaxLength } from "class-validator";
import type { Request, Response } from "express";
import { CurrentUser } from "../audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../auth/auth.service";
import { AuthenticationGuard } from "../authorization/authentication.guard";
import { AttachmentsService } from "./attachments.service";

class LinkAttachmentDto { @IsString() @MaxLength(80) entity_type!: string; @IsUUID() entity_id!: string; @IsString() @MaxLength(500) remark?: string; }

@Controller("attachments")
@UseGuards(AuthenticationGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}
  @Post() @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: CurrentUserType) { return { data: await this.attachments.upload(file, user), meta: {} }; }
  @Post(":id/links") async link(@Param("id") id: string, @Body() input: LinkAttachmentDto, @CurrentUser() user: CurrentUserType) { return { data: await this.attachments.link(id, input.entity_type, input.entity_id, user, input.remark), meta: {} }; }
  @Get(":id/download") async download(@Param("id") id: string, @Res() response: Response) {
    const { attachment, buffer } = await this.attachments.download(id);
    response.setHeader("content-type", attachment.mimeType);
    response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    response.send(buffer);
  }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.attachments.softDelete(id, user), meta: {} }; }
}
