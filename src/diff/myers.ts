/**
 * ⭐ 阶段 2 Diff 引擎核心：手写 Myers 最短编辑脚本算法（行级）。
 *
 * 设计目的：
 *   把「旧文本 → 新文本」的差异表达成**最短的一组增删操作**（最少的 - / +），
 *   这是 unified diff、补丁 apply、终端高亮三者共同的底层数据。
 *
 * 设计价值（为什么不调 `diff`/`jsdiff` 库）：
 *   1. 这是项目蓝图点名「禁止调库」的灵魂模块——亲手实现才补得上算法短板。
 *   2. Myers 是 git/diff 工具的默认算法，能讲清「为什么 diff 是这样」是面试差异化。
 *
 * 算法本质（Myers, O((N+M)·D)）：
 *   把 diff 看成在「编辑图」上找最短路径——从左上角 (0,0) 走到右下角 (N,M)：
 *     - 向右一步 = 删除 a 的一行（消耗 a 的一个字符）
 *     - 向下一步 = 插入 b 的一行（消耗 b 的一个字符）
 *     - 沿对角线 = 两行相同，免费走（这就是「公共子序列」）
 *   D 是非对角线步数 = 编辑距离。按 D 从 0 递增做 BFS，第一次到达终点时
 *   走过的对角线数最多 → 增删最少。比朴素 LCS 的 O(N·M) DP 更省：只跟差异量 D 相关，
 *   相似文件（D 小）几乎线性。
 *
 * 这里按「行」为最小单位：代码 diff 关心的是行级增删，且行级状态空间远小于字符级，
 * 既快又贴近人类审阅 diff 的直觉。
 */

/** 一行的差异操作。equal=两侧都有，delete=仅旧有(-)，insert=仅新有(+)。 */
export type LineOp =
  | { type: "equal"; line: string }
  | { type: "delete"; line: string }
  | { type: "insert"; line: string };

/**
 * 把文本切成「带行尾的行」。
 *
 * 为什么连行尾一起留：join("") 能**逐字节无损**还原原文，
 * patch apply 重建文件时不会丢/改换行；同时「有无结尾换行」会让两行不相等，
 * 自然表达出 git 的「\ No newline at end of file」语义。
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * 计算 a → b 的行级最短编辑脚本（Myers）。
 *
 * 返回按原文顺序排列的操作序列：equal/delete 对应 a 的行，insert 对应 b 的行。
 * 还原关系：旧文本 = 取出所有 equal+delete 的 line；新文本 = 取出所有 equal+insert 的 line。
 */
export function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;

  // 退化情形：一侧为空，直接全删或全插，省掉建图开销。
  if (n === 0) return b.map((line) => ({ type: "insert", line }) as LineOp);
  if (m === 0) return a.map((line) => ({ type: "delete", line }) as LineOp);

  const max = n + m;
  // V[k] = 在对角线 k 上能到达的最大 x。k = x - y，范围 [-max, max]，用 offset 平移成非负下标。
  const offset = max;
  const v = new Array<number>(2 * max + 1).fill(0);
  // 记录每一步 d 的 V 快照，用于回溯出具体路径（只存到达终点前的轨迹）。
  const trace: number[][] = [];

  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // 决定这一格从「下方(插入)」还是「左方(删除)」延伸而来：
      // 取能走得更远(x 更大)的前驱，从而贪心地多吃对角线。
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!; // 向下：插入 b 的一行，x 不变
      } else {
        x = v[k - 1 + offset]! + 1; // 向右：删除 a 的一行，x+1
      }
      let y = x - k;
      // 蛇形(snake)：能沿对角线走多远走多远——连续相同行全部免费吃掉。
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  return backtrack(trace, a, b, offset);
}

/**
 * 从 trace 逆推路径，产出正序的 LineOp[]。
 *
 * 从终点 (n,m) 往回走：每一步根据当时的 V 判断上一格是插入还是删除，
 * 中间的对角线段就是 equal。逆序收集后反转成正序。
 */
function backtrack(
  trace: number[][],
  a: string[],
  b: string[],
  offset: number
): LineOp[] {
  const ops: LineOp[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;

    // 还原这一步是从「下(插入)」还是「左(删除)」来的，与正向选择规则一致。
    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
      prevK = k + 1; // 来自插入
    } else {
      prevK = k - 1; // 来自删除
    }

    const prevX = v[prevK + offset]!;
    const prevY = prevX - prevK;

    // 先把这一步之前的对角线(相同行)记为 equal。
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: a[x - 1]! });
      x--;
      y--;
    }

    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: "insert", line: b[prevY]! }); // 向下
      } else {
        ops.push({ type: "delete", line: a[prevX]! }); // 向右
      }
    }

    x = prevX;
    y = prevY;
  }

  // d=0 之前残留的对角线（开头的公共前缀）。
  while (x > 0 && y > 0) {
    ops.push({ type: "equal", line: a[x - 1]! });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ type: "delete", line: a[x - 1]! });
    x--;
  }
  while (y > 0) {
    ops.push({ type: "insert", line: b[y - 1]! });
    y--;
  }

  return ops.reverse();
}
