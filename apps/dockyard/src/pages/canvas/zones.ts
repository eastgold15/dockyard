/**
 * 分界车道规则（单一事实源）：本机车道右缘钉在 -ZONE_GAP，远程车道左缘钉在 +ZONE_GAP，
 * 中间是谁都进不去的中立带。车道背景由卡片 bounds 派生、内缘钉在同一常量上——
 * 墙（clamp/422）与视觉（背景）读的同一份规则，不可能脱节。
 * 纯常量与纯函数：浏览器包可安全引用。
 */
export const ZONE_GAP = 24;

/** 车道钳制：卡片完整矩形不许压中立带（本机卡右缘 ≤ -GAP，远程卡左缘 ≥ GAP） */
export const clampCardX = (local: boolean, x: number, w: number): number =>
  local ? Math.min(x, -ZONE_GAP - w) : Math.max(x, ZONE_GAP);

/** 车道违例判定（服务端 422 裁决用，与 clampCardX 同一规则） */
export const violatesLane = (local: boolean, x: number, w: number): boolean =>
  local ? x + w > -ZONE_GAP : x < ZONE_GAP;

export interface Rect { x: number; y: number; w: number; h: number }

const PAD_X = 48, PAD_TOP = 64, PAD_BOTTOM = 48;
/** 空车道占位尺寸（无卡时也要看得到车道，发现"该把谁放进来"） */
const EMPTY_W = 420, EMPTY_H = 300;

/**
 * 车道矩形 = 车道内卡片 bounds + 内边距，内缘钉在中立带：
 * 本机车道右缘恒为 -GAP（向左生长），远程车道左缘恒为 +GAP（向右生长）。
 */
export function laneRect(local: boolean, cards: Rect[]): Rect {
  if (cards.length === 0) {
    return local
      ? { x: -ZONE_GAP - EMPTY_W, y: 40, w: EMPTY_W, h: EMPTY_H }
      : { x: ZONE_GAP, y: 40, w: EMPTY_W, h: EMPTY_H };
  }
  const left = Math.min(...cards.map((c) => c.x)) - PAD_X;
  const top = Math.min(...cards.map((c) => c.y)) - PAD_TOP;
  const bottom = Math.max(...cards.map((c) => c.y + c.h)) + PAD_BOTTOM;
  if (local) {
    return { x: left, y: top, w: -ZONE_GAP - left, h: bottom - top };
  }
  const right = Math.max(...cards.map((c) => c.x + c.w)) + PAD_X;
  return { x: ZONE_GAP, y: top, w: right - ZONE_GAP, h: bottom - top };
}
