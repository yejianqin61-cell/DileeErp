"use client";

import { useEffect, type RefObject } from "react";
import { Loader2, SendHorizonal, Square } from "lucide-react";

/**
 * 底部输入区（ChatGPT 风格多行输入框）。
 *
 * 交互契约：
 *   * 空白态与对话态用的是**同一个**组件，行为一致；
 *   * Enter 发送、Shift+Enter 换行；
 *   * 自动增高，上限 168px（超过后框内滚动），高度用内联 style 写，避免撑坏底部布局；
 *   * 运行中右下角换成停止按钮（后端 POST /runs/:id/cancel 真实支持取消）；
 *   * 提交失败/忙碌时错误提示贴在输入框上方，草稿留在输入框里可直接重试。
 */
export function AgentComposer({
  value, onChange, onSubmit, onStop, busy, canStop, disabled, phaseLabel, notice, onRetryNotice, onDismissNotice, inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** 运行中：显示停止按钮与进行中的阶段文案。 */
  busy: boolean;
  /** 是否已经拿到 run_id（POST 还没返回时没有可取消的对象，按钮先禁用而不是假装能停）。 */
  canStop: boolean;
  /** 会话还没就绪（初次加载）时禁止输入。 */
  disabled?: boolean;
  phaseLabel: string;
  notice: string | null;
  onRetryNotice?: () => void;
  onDismissNotice?: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // 自动增高在输入事件里同步做（而不是 useEffect 之后再改高度）：避免先按旧高度渲染一帧再跳变。
  function resize(element: HTMLTextAreaElement) {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }

  // 程序化填入（点推荐问题）不经过 onChange，这里补一次测量，保证长问题直接展开成多行。
  useEffect(() => {
    if (inputRef.current) resize(inputRef.current);
  }, [value, inputRef]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // 中文输入法选词时的 Enter 不是发送：isComposing / keyCode 229 都要放过，
    // 否则打「订单」按 Enter 选字会把半截问题发出去。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (busy || disabled || !value.trim()) return;
    onSubmit();
  }

  return <div className="agent-composer-wrap">
    <div className="agent-composer">
      {notice && <div className="agent-notice" role="alert" data-testid="agent-notice">
        <span className="agent-notice-text">{notice}</span>
        {onRetryNotice && <button type="button" className="agent-notice-action" onClick={onRetryNotice} data-testid="agent-notice-retry">重试</button>}
        {onDismissNotice && <button type="button" className="agent-notice-action" onClick={onDismissNotice} aria-label="关闭提示" data-testid="agent-notice-dismiss">关闭</button>}
      </div>}

      <div className="agent-input-box" data-busy={busy ? "true" : "false"}>
        <textarea
          ref={inputRef}
          className="agent-input"
          value={value}
          rows={1}
          aria-label="业务问题"
          placeholder="问点什么：例如「SO-2026 有哪些订单？现在到哪一步了？」"
          disabled={disabled}
          onChange={(event) => { onChange(event.target.value); resize(event.target); }}
          onKeyDown={handleKeyDown}
          data-testid="agent-input"
        />
        <div className="agent-input-row">
          <span className="agent-input-status" data-testid="agent-input-status" aria-live="polite">
            {phaseLabel ? <span data-testid="business-query-phase">{phaseLabel}</span> : <span>Enter 发送 · Shift + Enter 换行</span>}
            {busy && phaseLabel && <Loader2 size={12} className="spin" aria-hidden="true" />}
          </span>
          <div className="agent-input-actions">
            {busy
              ? <button type="button" className="agent-stop" onClick={onStop} disabled={!canStop} title={canStop ? "停止生成" : "正在提交，稍候可停止"} aria-label="停止生成" data-testid="business-query-cancel"><Square size={12} fill="currentColor" /></button>
              : <button type="button" className="agent-send" onClick={onSubmit} disabled={disabled || !value.trim()} title="发送" aria-label="发送" data-testid="business-query-submit"><SendHorizonal size={16} /></button>}
          </div>
        </div>
      </div>

      {/* 数据权限提示保持一句话，不堆免责声明。 */}
      <p className="agent-footnote">回答依据你的数据权限生成，事实来自厂内单据；财务数据按角色档位开放。</p>
    </div>
  </div>;
}
