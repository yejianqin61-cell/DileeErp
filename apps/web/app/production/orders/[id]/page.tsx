"use client";

import { useParams } from "next/navigation";
import { ErrorState } from "../../../../components/feedback/states";
import { ProductionOrderDetailPage } from "../../../../components/production/production-order-detail-page";

export default function ProductionOrderDetailRoute() {
  const { id } = useParams<{ id?: string }>();
  return id ? <div className="page-root" data-testid="page-production-orders-id"><ProductionOrderDetailPage orderId={id} /></div> : <div className="page-root" data-testid="page-production-orders-id"><ErrorState message="缺少生产单 ID" /></div>;
}
