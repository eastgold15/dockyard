/** @jsxImportSource solid-js */
/** 画布 client 页入口（L5）：codegen 生成壳 HTML 引这个文件，挂载即全部 */
import { render } from "solid-js/web";
import { App } from "./app";

render(() => <App />, document.getElementById("root")!);
