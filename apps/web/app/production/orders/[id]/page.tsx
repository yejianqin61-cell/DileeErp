"use client";

import { useParams } from "next/navigation";
import { ErrorState } from "../../../../components/feedback/states";
import { ProductionOrderDetailPage } from "../../../../components/production/production-order-detail-page";

export default function ProductionOrderDetailRoute() {
  const { id } = useParams<{ id?: string }>();
  return id ? <ProductionOrderDetailPage orderId={id} /> : <ErrorState message="缺少生产单 ID" />;
}
