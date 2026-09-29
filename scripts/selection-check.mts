/**
 * 选区偏移换算自检（npm run check:selection）。
 *
 * 不依赖浏览器：用最小 DOM 模拟 HighlightedText 的渲染结果
 * （纯文本 + <mark class="term-mark"> 包裹 + <button class="ref-chip">），
 * 覆盖端点落在文本节点、mark / chip 嵌套元素前后沿、容器子节点边界、
 * 反向选区、空选区、跨容器选区等情形。
 */
import {
  domOffset,
  readContainerSelection,
  isValidTextRange,
} from '../src/lib/selection';

// ---------- 最小 DOM ----------

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const POS_PRECEDING = 0x02;
const POS_FOLLOWING = 0x04;
const POS_CONTAINS = 0x08;
const POS_CONTAINED_BY = 0x10;

class FakeNode {
  nodeType: number;
  nodeName = '#node';
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  protected _text = '';

  constructor(nodeType: number, textContent = '') {
    this.nodeType = nodeType;
    this._text = textContent;
  }

  get textContent(): string {
    return this._text;
  }
  set textContent(v: string) {
    this._text = v;
  }

  contains(other: Node | null): boolean {
    let n: FakeNode | null = other as unknown as FakeNode;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  /** 与浏览器 Node.compareDocumentPosition 同位标记的简化实现（按文档序） */
  compareDocumentPosition(other: FakeNode): number {
    if (other === this) return 0;
    if (this._contains(other)) return POS_FOLLOWING | POS_CONTAINED_BY;
    if (other._contains(this)) return POS_PRECEDING | POS_CONTAINS;
    const pa = this._path();
    const pb = other._path();
    // 跳过公共祖先前缀（至少包含根节点），在首个分叉层比较兄弟次序
    let depth = 0;
    while (
      depth < pa.length - 1 &&
      depth < pb.length - 1 &&
      pa[depth] === pb[depth]
    ) {
      depth++;
    }
    const ia = pa[depth].parentNode!.childNodes.indexOf(pa[depth]);
    const ib = pb[depth].parentNode!.childNodes.indexOf(pb[depth]);
    return ia < ib ? POS_FOLLOWING : POS_PRECEDING;
  }

  private _contains(other: FakeNode): boolean {
    let n: FakeNode | null = other;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  private _path(): FakeNode[] {
    const path: FakeNode[] = [];
    let n: FakeNode | null = this;
    while (n) {
      path.unshift(n);
      n = n.parentNode;
    }
    return path;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
}

class FakeText extends FakeNode {
  constructor(data: string) {
    super(TEXT_NODE, data);
    this.nodeName = '#text';
  }
  get length(): number {
    return this._text.length;
  }
  override get textContent(): string {
    return this._text;
  }
  override set textContent(v: string) {
    this._text = v;
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  constructor(tag: string) {
    super(ELEMENT_NODE);
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
  }
  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.childNodes = [];
    this.appendChild(new FakeText(v));
  }
}

class FakeTreeWalker {
  private nodes: FakeNode[] = [];
  private i = -1;
  constructor(root: FakeNode) {
    const walk = (n: FakeNode) => {
      if (n.nodeType === TEXT_NODE) this.nodes.push(n);
      n.childNodes.forEach(walk);
    };
    walk(root);
  }
  nextNode(): FakeNode | null {
    this.i++;
    return this.nodes[this.i] ?? null;
  }
}

interface FakeRange {
  startContainer: FakeNode;
  startOffset: number;
  endContainer: FakeNode;
  endOffset: number;
  collapsed: boolean;
}

let selection: { range: FakeRange | null } = { range: null };

// selection.ts 运行时使用的全局对象
(globalThis as { document?: unknown }).document = {
  createTreeWalker: (root: FakeNode) => new FakeTreeWalker(root),
};
(globalThis as { window?: unknown }).window = {
  getSelection: () =>
    selection.range
      ? {
          rangeCount: 1,
          isCollapsed: selection.range.collapsed,
          getRangeAt: () => selection.range,
        }
      : { rangeCount: 0, isCollapsed: true, getRangeAt: () => null },
};

// ---------- 构造与 HighlightedText 同构的 DOM ----------
// 原文：依第五条及本办法规定。  （「第五条」= ref chip 偏移 1..4，「规定」= term mark 偏移 8..10）
const FULL = '依第五条及本办法规定。';
const CHIP = '第五条'; // 偏移 1..4
const TERM = '规定'; // 偏移 8..10

function buildDom(): FakeElement {
  const root = new FakeElement('div');
  // 文本段按 points 切分：依 | <button>第五条</button> | 及本办法 | <mark>规定</mark> | 。
  root.appendChild(new FakeText('依'));
  const chip = new FakeElement('button');
  chip.appendChild(new FakeText(CHIP));
  root.appendChild(chip);
  root.appendChild(new FakeText('及本办法'));
  const mark = new FakeElement('mark');
  mark.appendChild(new FakeText(TERM));
  root.appendChild(mark);
  root.appendChild(new FakeText('。'));
  return root;
}

// ---------- 自检 ----------
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name} ${extra}`);
  }
}

const root = buildDom();
const textNodes = (() => {
  const out: FakeText[] = [];
  for (const c of root.childNodes) {
    if (c.nodeType === TEXT_NODE) out.push(c as FakeText);
    else out.push(c.childNodes[0] as FakeText);
  }
  return out;
})();
// 拼接结果必须与原正文字符序列一致
check('渲染文本等于原正文', root.textContent === FULL, root.textContent);

const off = (n: FakeNode, o: number) =>
  domOffset(root as unknown as HTMLElement, n as unknown as Node, o);

// 文本节点内部偏移
check('首文本节点偏移', off(textNodes[0], 0) === 0);
check('首文本节点偏移 1', off(textNodes[0], 1) === 1);
check('chip 内文本偏移', off(textNodes[1], 0) === 1 && off(textNodes[1], 3) === 4);
// chip 后沿：容器边界 offset=2（chip 之后）
check('chip 后沿=4', off(root, 2) === 4);
// chip 前沿：容器边界 offset=1（chip 之前）
check('chip 前沿=1', off(root, 1) === 1);
// 容器两端
check('容器起点', off(root, 0) === 0);
check('容器终点', off(root, root.childNodes.length) === FULL.length);
// mark 前后沿（容器子节点边界：mark 位于 8..10）
check('mark 前沿=8', off(root, 3) === 8);
check('mark 后沿=10', off(root, 3 + 1) === 10);
// 端点落在 chip / mark 元素自身的边界（嵌套元素边界，offset 0 / childCount）
const chipEl = root.childNodes[1];
const markEl = root.childNodes[3];
check('元素自身 offset=0 = chip 前沿', off(chipEl, 0) === 1);
check('元素自身 offset=1 = chip 后沿', off(chipEl, 1) === 4);
check('mark offset=0 = mark 前沿', off(markEl, 0) === 8);
check('mark offset=1 = mark 后沿', off(markEl, 1) === 10);
// mark 内文本节点尾
check('mark 内文本尾=10', off(textNodes[3], 2) === 10);
// 容器外节点 → null
const outside = new FakeText('x');
check('容器外节点 → null', domOffset(root as unknown as HTMLElement, outside as unknown as Node, 0) === null);

// readContainerSelection：选区恰好是 chip
function setRange(
  sc: FakeNode,
  so: number,
  ec: FakeNode,
  eo: number,
): void {
  const collapsed = sc === ec && so === eo;
  selection = { range: { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo, collapsed } };
}
setRange(root, 1, root, 2);
let r = readContainerSelection(root as unknown as HTMLElement);
check('chip 整体选区 [1,4)', r?.start === 1 && r.end === 4, JSON.stringify(r));
check('选区引文即 chip 原文', r ? FULL.slice(r.start, r.end) === CHIP : false);

// 跨越 普通文本 + chip：「依第五条」
setRange(textNodes[0], 0, root, 2);
r = readContainerSelection(root as unknown as HTMLElement);
check('跨普通文本+chip [0,4)', r?.start === 0 && r.end === 4, JSON.stringify(r));

// 跨越 chip + mark + 普通文本：「第五条及本办法规定」（1..10）
setRange(root, 1, root, 4);
r = readContainerSelection(root as unknown as HTMLElement);
check('跨 chip+文本+mark [1,10)', r?.start === 1 && r.end === 10, JSON.stringify(r));
check('跨结构引文正确', r ? FULL.slice(r.start, r.end) === '第五条及本办法规定' : false);

// 端点落在 chip 内文本，另一端落在 mark 后
setRange(textNodes[1], 1, root, 4);
r = readContainerSelection(root as unknown as HTMLElement);
check('chip 内起点+mark 后终点', r?.start === 2 && r.end === 10, JSON.stringify(r));

// 反向选区（end 在前）应被规整
setRange(root, 4, textNodes[0], 0);
r = readContainerSelection(root as unknown as HTMLElement);
check('反向选区规整', r?.start === 0 && r.end === 10, JSON.stringify(r));

// 空选区
setRange(textNodes[0], 0, textNodes[0], 0);
check('空选区 → null', readContainerSelection(root as unknown as HTMLElement) === null);

// 无选区
selection.range = null;
check('无选区 → null', readContainerSelection(root as unknown as HTMLElement) === null);

// 跨容器：一端在容器外
const other = new FakeElement('div');
other.appendChild(new FakeText('别的卡片'));
setRange(other.childNodes[0], 0, root, 2);
check('跨容器选区 → null', readContainerSelection(root as unknown as HTMLElement) === null);

// 嵌套结构：批注 mark 包裹规范 mark（渲染器对同时命中的片段自内向外包裹）
{
  const text = '甲乙规定丙'; // 「规定」偏移 2..4，外层 ann-mark 覆盖 0..5
  const nroot = new FakeElement('div');
  const ann = new FakeElement('mark');
  ann.setAttribute?.('class', 'ann-mark');
  nroot.appendChild(ann);
  const term = new FakeElement('mark');
  ann.appendChild(new FakeText('甲乙'));
  term.appendChild(new FakeText('规定'));
  ann.appendChild(term);
  ann.appendChild(new FakeText('丙'));
  check('嵌套渲染文本等于原文', nroot.textContent === text, nroot.textContent);
  const nestedOff = (n: FakeNode, o: number) =>
    domOffset(nroot as unknown as HTMLElement, n as unknown as Node, o);
  // 外层 ann 前后沿
  check('嵌套：外层前沿=0', nestedOff(ann, 0) === 0);
  check('嵌套：外层后沿=5', nestedOff(ann, ann.childNodes.length) === 5);
  // 端点落在内层 term 的前后沿
  check('嵌套：term 前沿=2', nestedOff(term, 0) === 2);
  check('嵌套：term 后沿=4', nestedOff(term, 1) === 4);
  // term 内文本节点
  const termText = term.childNodes[0];
  check('嵌套：term 文本起点=2', nestedOff(termText, 0) === 2);
  check('嵌套：term 文本尾=4', nestedOff(termText, 2) === 4);
}

// isValidTextRange
check('合法区间', isValidTextRange({ start: 1, end: 4 }, FULL, CHIP));
check('空区间非法', !isValidTextRange({ start: 4, end: 4 }, FULL));
check('越界非法', !isValidTextRange({ start: 1, end: 99 }, FULL));
check('正文变化后引文不符 → 失效', !isValidTextRange({ start: 1, end: 4 }, '依第六条及本办法规定。', CHIP));
check('无期望原文时只校验边界', isValidTextRange({ start: 0, end: 2 }, '甲乙'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
