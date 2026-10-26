import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import BusinessQueryPage from "../app/business-query/page";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const stream = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../lib/api-client", () => ({
  ApiClientError: class ApiClientError extends Error {},
  apiGet: api.get,
  apiPost: api.post,
}));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: stream }));

describe("BusinessQueryPage · 刷新恢复", () => {
  it("活动 run 的快照恢复后从 latest_seq 续接 SSE，不重新 POST 提问", async () => {
    api.get.mockResolvedValueOnce({ data: { sessions: [{ session_id: "s-1" }] } });
    api.get.mockResolvedValueOnce({ data: { session_id: "s-1", runs: [{ run_id: "r-1", state: "responding", question: "订单进度", answer: "已有回答", sources: [], latest_seq: 7, error_code: null, access_level: "operational", created_at: "2026-10-26" }] } });

    render(<BusinessQueryPage />);

    expect(await screen.findByTestId("business-query-answer")).toHaveTextContent("已有回答");
    await waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({ runId: "r-1", lastSeq: 7 })));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("恢复中的 run 在首个答案前失败时，页面仍显示稳定错误", async () => {
    api.get.mockResolvedValueOnce({ data: { sessions: [{ session_id: "s-1" }] } });
    api.get.mockResolvedValueOnce({ data: { session_id: "s-1", runs: [{ run_id: "r-2", state: "responding", question: "订单进度", answer: "", sources: [], latest_seq: 1, error_code: null, access_level: "operational", created_at: "2026-10-26" }] } });
    stream.mockImplementationOnce(async (options: { onEvent: (event: unknown) => void }) => options.onEvent({ seq: 2, type: "error", data: { code: "AGENT_RUN_TIMEOUT", message: "本次回答超时，请重试" } }));

    render(<BusinessQueryPage />);

    expect(await screen.findByTestId("business-query-error")).toHaveTextContent("本次回答超时，请重试");
  });
});
