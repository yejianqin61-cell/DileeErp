/**
 * 上传体积口径（全站唯一一份）。
 *
 * 为什么要有这个文件：同一个「10MB」以前在 5 个控制器、前端常量与边缘 nginx 配置里各写一遍，
 * 于是链路上最窄的那一段说了算 —— 2026-11-12 的故障就是这么来的：应用写 10MB、前端提示 10MB，
 * 而边缘 nginx 吃默认值 1m，1.5MB 的销售单 Excel 在**转发之前**就被 413 掉，界面只说「读取失败」。
 * 现在产品口径只写在这里，边缘的上限由 `scripts/deploy/nginx-dilee.conf` 保证**不比它窄**，
 * 部署时用「真传一个 10MB 的文件」验（`scripts/deploy/remote-nginx.sh`）。
 *
 * 口径（用户 2026-11-12 明确）：**单文件上限 10MB**，且是「含 10MB」。
 *
 * ⚠️ 为什么给 Multer 的数要比它大 1 字节：busboy/multer 的 `limits.fileSize` 是在
 * **达到或超过**上限时就判 `LIMIT_FILE_SIZE`（实测：`fileSize: 10*1024*1024` 时，
 * 正好 10,485,760 字节的文件会被拒，10,485,759 能过）。要让「单文件 10MB」这句话字面成立，
 * 给 Multer 的就必须是 `10MB + 1`：正好 10MB 放行，10MB + 1 字节才拒。
 * 别再把这个 +1 挪到别处去凑 —— 挪一次就没人知道它为什么在那儿了。
 */
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 给 Multer `limits.fileSize` 用的数（= 产品上限 + 1，理由见本文件头部）。 */
export const MULTER_DOCUMENT_FILE_SIZE_LIMIT = MAX_DOCUMENT_UPLOAD_BYTES + 1;
