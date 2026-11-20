/** @jsxImportSource @solidjs/web */
/** servers client 页入口（整页 Solid）：codegen 生成壳 HTML 引这个文件，挂载即全部 */
import { render } from "@solidjs/web";
import { App } from "./app";

render(() => <App />, document.getElementById("root")!);
