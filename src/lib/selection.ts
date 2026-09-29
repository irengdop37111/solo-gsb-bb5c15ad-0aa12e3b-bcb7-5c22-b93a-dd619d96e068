/**
 * 正文选区与「原正文字符序列」之间的换算。
 *
 * 渲染层（HighlightedText）输出的可见文本与节点 node.text 逐字符一致：
 * 普通文本直接渲染，规范用语 <mark> 只包裹不增字，引用 chip（<button>）
 * 的可见文本即扫描到的 span.raw（= node.text 对应切片）。因此容器的
 * 全部 Text 节点顺序拼接恰好等于 node.text，DOM 选区偏移可严格映射为
 * 原正文字符偏移。
 */

// Node 类型 / compareDocumentPosition 位标记（取字面量，避免依赖浏览器全局 Node）
const TEXT_NODE = 3;
const POS_PRECEDING = 0x02; // 另一节点位于本节点之前
const POS_CONTAINED_BY = 0x10; // 另一节点在本节点之内（本节点包含它）

export interface TextRange {
  start: number;
  end: number;
}

function eachTextNode(container: HTMLElement, fn: (t: Text) => void): void {
  const walker = document.createTreeWalker(container, 0x04 /* NodeFilter.SHOW_TEXT */);
  let cur = walker.nextNode();
  while (cur) {
    fn(cur as Text);
    cur = walker.nextNode();
  }
}

/** 容器内严格位于 refNode 之前的全部 Text 节点字符数 */
function precedingTextLength(container: HTMLElement, refNode: Node): number {
  let total = 0;
  eachTextNode(container, (t) => {
    // 仅统计「严格在前」：位置标记恰为 PRECEDING（祖先关系返回的
    // PRECEDING|CONTAINS 表示 t 在 refNode 之内，不得计入）
    if (refNode.compareDocumentPosition(t) === POS_PRECEDING) total += t.textContent?.length ?? 0;
  });
  return total;
}

/**
 * 把 DOM（node, offset）边界换算为 container 文本序列中的字符偏移。
 *
 * 选区端点落在嵌套元素边界（如 <mark>/<button> 的前后沿、容器自身的
 * 子节点序）时，旧实现忽略非文本节点上的 offset，会把端点错误地退回到
 * 该元素首个文本节点之前；这里严格按 DOM 边界点语义计数：
 * 切点前的 Text 节点整段计入，切点后的不计。
 */
export function domOffset(container: HTMLElement, node: Node, offset: number): number | null {
  if (!container.contains(node)) return null;

  // 文本节点边界：累加其之前的文本，再加节点内偏移
  if (node.nodeType === TEXT_NODE) {
    return precedingTextLength(container, node) + offset;
  }

  const childCount = node.childNodes.length;

  // 边界位于首个子节点之前
  if (offset <= 0) {
    return node === container ? 0 : precedingTextLength(container, node);
  }
  // 边界位于末个子节点之后：计入「在该元素之内」或「在其之前」的文本
  if (offset >= childCount) {
    if (node === container) return container.textContent?.length ?? 0;
    let total = 0;
    eachTextNode(container, (t) => {
      const pos = node.compareDocumentPosition(t);
      // t 位于 node 之内（CONTAINED_BY）、之前（PRECEDING），或就是 node 自身
      if (pos === 0 || (pos & POS_CONTAINED_BY) !== 0 || pos === POS_PRECEDING) {
        total += t.textContent?.length ?? 0;
      }
    });
    return total;
  }

  // 边界位于两个子节点之间：后一个子节点之前的文本长度
  return precedingTextLength(container, node.childNodes[offset]);
}

/**
 * 读取完全落在 container 内的非空选区，返回按原正文字符序列的区间。
 * 跨节点（端点在其他正文卡片）、空选区一律返回 null。
 */
export function readContainerSelection(container: HTMLElement): TextRange | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const start = domOffset(container, range.startContainer, range.startOffset);
  const end = domOffset(container, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  if (e <= s) return null;
  return { start: s, end: e };
}

/**
 * 校验候选区间在当前正文中仍为有效非空切片：
 * 边界合法，且切片与期望原文一致（正文变化后旧选区即失效）。
 */
export function isValidTextRange(
  range: TextRange,
  text: string,
  expected?: string,
): boolean {
  const { start, end } = range;
  if (!(start >= 0 && end > start && end <= text.length)) return false;
  if (expected !== undefined && text.slice(start, end) !== expected) return false;
  return true;
}
