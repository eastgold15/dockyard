/**
 * 透镜（项目过滤）模块级信号：世界地图形态下画布不再有项目边界，
 * 透镜只是「只看某个项目」的视图过滤。null = 世界视图（全部项目）。
 * 模块级信号而非 context：app（选择器）/board（过滤）/nodes（项目徽章）三处平级消费，
 * 没有嵌套提供方，模块信号最简。
 */
import { createSignal } from "solid-js";

export const [lens, setLens] = createSignal<number | null>(null);
