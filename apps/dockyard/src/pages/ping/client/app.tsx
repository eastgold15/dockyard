/** @jsxImportSource @solidjs/web */
/** ping 测试页（整页 Solid）：验证 client 端点连通与共享控件。 */
import {
  createSignal,
} from "solid-js";
import { api, unwrap } from "./api";
import { AppShell, Button, PageHeader } from "@/shared/solid-ui/index";
import { FeedbackHost, toast } from "@/shared/solid-ui/feedback";

export function App() {
  const [out, setOut] = createSignal("");
  const ping = async () => {
    try {
      setOut((await unwrap(api.hello.get())).message);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <AppShell>
      <PageHeader title="ping" />
      <div class="flex flex-1 flex-col gap-3 p-6">
        <Button label="片段测试" onClick={() => void ping()} />
        <div class="mono text-sm text-neutral-300">{out()}</div>
      </div>
      <FeedbackHost />
    </AppShell>
  );
}
