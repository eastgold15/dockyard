// webview-bun 发布的 .ts 源内 Pointer 类型与当前 bun-types 不兼容（TS2322），
// 且 skipLibCheck 不覆盖 .ts 源文件 —— 用 paths 映射到本地最小声明。
declare module "webview-bun" {
  export enum SizeHint {
    NONE = 0,
    MIN = 1,
    MAX = 2,
    FIXED = 3,
  }
  export class Webview {
    constructor(debug?: boolean, size?: {
      width: number;
      height: number;
      hint: SizeHint;
    });
    title: string;
    navigate(url: string): void;
    run(): void;
  }
}
