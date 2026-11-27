import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * 列表分页的硬上限（2026-11-27：200 → 1000）。
 *
 * 用户原话：「所有单据前端最多只能显示 200 单，再多就展示不了了。这个先扩充到 1000 单。
 * 以后我们要优化单据完毕归档机制。」
 *
 * 为什么是「先扩到 1000」而不是直接做归档：
 * 200 这个数当初是「一次拉全量再在前端过滤」的防呆上限，不是业务上限。厂里的单据量已经
 * 越过它，于是表现成「第 201 张单看不到」——用户以为是 bug，其实是护栏。扩到 1000 是止血；
 * 真正的解法是**单据归档**（已完毕的老单据移出活动列表），那是下一轮的事。
 *
 * 为什么要一个共享常量：这个上限原本散在 6 个控制器/服务里各写一遍（200/200/500/200…），
 * 改一处漏五处，前端还会因为后端拒绝而 400。现在只有这一处是真源。
 *
 * 注意它挡的是「一次要多少条」，不是「一共能存多少条」。1000 条订单按工作台的批量取数
 * 口径（整批 22 个查询）约占十几 MB 内存，2 vCPU 的机器能承受；再往上就该分页或归档了。
 */
export const MAX_PAGE_SIZE = 1000;

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  page_size = 20;

  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
