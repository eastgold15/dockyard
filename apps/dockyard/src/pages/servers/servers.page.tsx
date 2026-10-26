import { definePage } from "@elysiax/core";
import { ServerList } from "./servers.partials";

export default definePage(async ({ di }) => ({
  title: "服务器 · Dockyard",
  content: <ServerList servers={await di.get("serverService").list()} />,
}));
