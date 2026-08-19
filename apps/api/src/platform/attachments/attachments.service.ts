import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuditService } from "../audit/audit.service";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);

@Injectable()
export class AttachmentsService {
  private readonly storageRoot = resolve(process.env.ATTACHMENT_STORAGE_PATH ?? "./var/attachments");
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async upload(file: Express.Multer.File, user: CurrentUser) {
    if (!file?.buffer?.length) throw new BadRequestException("未提供文件");
    if (file.size > MAX_FILE_SIZE || !ALLOWED_MIME_TYPES.has(file.mimetype)) throw new BadRequestException("不支持的文件类型或文件过大");
    const storageKey = `${randomUUID()}-${createHash("sha256").update(file.buffer).digest("hex")}`;
    await mkdir(this.storageRoot, { recursive: true });
    await writeFile(this.pathFor(storageKey), file.buffer, { flag: "wx" });
    try {
      return await this.prisma.attachment.create({ data: { fileName: file.originalname, storageKey, mimeType: file.mimetype, fileSize: BigInt(file.size), sha256: createHash("sha256").update(file.buffer).digest("hex"), ...this.audit.create(user) } });
    } catch (error) {
      await rm(this.pathFor(storageKey), { force: true });
      throw error;
    }
  }

  async link(attachmentId: string, entityType: string, entityId: string, user: CurrentUser, remark?: string) {
    await this.requireAttachment(attachmentId);
    return this.prisma.attachmentLink.create({ data: { attachmentId, entityType, entityId, remark, ...this.audit.create(user) } });
  }

  async download(id: string) {
    const attachment = await this.requireAttachment(id);
    return { attachment, buffer: await readFile(this.pathFor(attachment.storageKey)) };
  }

  async softDelete(id: string, user: CurrentUser) {
    await this.requireAttachment(id);
    return this.prisma.attachment.update({ where: { id }, data: this.audit.softDelete(user) });
  }

  private async requireAttachment(id: string) {
    const attachment = await this.prisma.attachment.findFirst({ where: { id, deletedAt: null } });
    if (!attachment) throw new NotFoundException("附件不存在");
    return attachment;
  }
  private pathFor(storageKey: string) { return join(this.storageRoot, storageKey); }
}
