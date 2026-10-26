import { definePage } from "@elysiax/core";
import { routes } from "../../../.elysiax/routes.gen";

export default definePage(async () => ({
  title: "ping",
  content: (
    <section>
      <h1>pong</h1>
      <button hx-get={routes.pages.ping.hello()} hx-target="#out">
        片段测试
      </button>
      <div id="out" />
    </section>
  ),
}));
