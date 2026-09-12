"use client";

// 全屏新建/编辑领料单、补料单：/production/material-issues/new?type=issue|replenishment
// 支持 ?production_order_id= 预选生产单、?movement_id= 继续编辑草稿。
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LoadingState } from "../../../../components/feedback/states";
import { MaterialSlipEditor } from "../../../../components/production/material-slip-editor";

function EditorWithParams() {
  const searchParams = useSearchParams();
  const type = searchParams.get("type") === "replenishment" ? "replenishment" : "issue";
  return <MaterialSlipEditor documentType={type} />;
}

export default function NewMaterialSlipPage() {
  return <Suspense fallback={<LoadingState label="正在加载单据编辑页" />}><EditorWithParams /></Suspense>;
}
