/** @jsxImportSource solid-js */
/**
 * 画布 client 页根组件：世界地图形态——Board 无项目边界，页头是「透镜选择器」
 * （全部项目 = 世界视图，默认值；选项目 = 只看该项目的卡）。
 * URL ?project=<id> 作初始透镜；?path=<本地路径> 幂等落库后聚焦该项目。
 */
import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import { canvasApi, unwrap } from "./api";
import { Board } from "./board";
import { DeployLogModal, DomainsModal, EnvDrawer, NewAppWizard, NewDbModal, ServiceDrawer } from "./drawers";
import { FeedbackHost } from "./feedback";
import { lens, setLens } from "./lens";
import { emitRefresh, UiContext, type UiBus, type View } from "./ui";

interface ProjectBrief { id: number; name: string }

/** URL → 初始透镜：?path 幂等落库后聚焦；?project 直接用；缺省世界视图（null） */
async function resolveInitialLens(): Promise<number | null> {
  const q = new URLSearchParams(location.search);
  const path = q.get("path");
  if (path) {
    const r = await unwrap(canvasApi["resolve-local"].get({ query: { path } }));
    return r.projectId;
  }
  const project = q.get("project");
  return project ? Number(project) : null;
}

/** 按 kind 收窄 view（给 Match 的 when 用，顺带带出该分支的字段类型） */
const viewAs = <K extends View["kind"]>(k: K, v: View) => (v.kind === k ? (v as Extract<View, { kind: K }>) : null);

function DrawerHost(props: { view: View }) {
  return (
    <Switch>
      <Match when={viewAs("new-app", props.view)}>{(v) => <NewAppWizard nodeId={v().nodeId} />}</Match>
      <Match when={viewAs("new-db", props.view)}>{(v) => <NewDbModal nodeId={v().nodeId} />}</Match>
      <Match when={viewAs("service", props.view)}>
        {(v) => <ServiceDrawer targetId={v().targetId} svc={v().svc} initialTab={v().tab} />}
      </Match>
      <Match when={viewAs("env", props.view)}>{(v) => <EnvDrawer targetId={v().targetId} />}</Match>
      <Match when={viewAs("domains", props.view)}>{(v) => <DomainsModal targetId={v().targetId} />}</Match>
      <Match when={viewAs("log", props.view)}>{(v) => <DeployLogModal targetId={v().targetId} dep={v().dep} />}</Match>
    </Switch>
  );
}

/** 切换透镜：写模块信号 + history.replaceState（世界视图时 URL 去掉 project 参数） */
function applyLens(id: number | null) {
  setLens(id);
  history.replaceState(null, "", id ? `/canvas?project=${id}` : "/canvas");
}

export function App() {
  const [missing, setMissing] = createSignal(false);
  const [projects, setProjects] = createSignal<ProjectBrief[]>([]);
  const [view, setView] = createSignal<View | null>(null);

  onMount(() => {
    // 项目列表与初始透镜并行解析；透镜 id 不在列表（如已删项目）→ 回退世界视图
    void (async () => {
      const [id, ps] = await Promise.all([
        resolveInitialLens().catch(() => null),
        unwrap(canvasApi.projects.get()).catch(() => [] as ProjectBrief[]),
      ]);
      setProjects(ps);
      if (ps.length === 0) {
        setMissing(true);
        return;
      }
      applyLens(id != null && ps.some((p) => p.id === id) ? id : null);
    })();
  });

  // bus 是稳定引用：open/close/refresh 全是 setView 的薄壳，无需 memo
  const bus: UiBus = {
    open: setView,
    close: () => setView(null),
    refresh: emitRefresh,
  };

  const lensProject = () => projects().find((p) => p.id === lens());

  return (
    <UiContext.Provider value={bus}>
      {/* 整页 client 壳没有 AppLayout：视口高度从这里开始，h-full 链条才有根 */}
      <div class="h-screen">
      <Show when={missing()}>
        <div class="flex h-full items-center justify-center text-sm text-neutral-500">
          先创建一个项目空间（左侧「项目」）
        </div>
      </Show>
      <Show when={!missing()}>
        <div class="flex h-full flex-col">
          <div class="flex h-14 shrink-0 items-center justify-between border-b border-harbor-800 px-6">
            <div class="flex flex-col">
              <h1 class="text-sm font-semibold text-neutral-100">
                {lensProject()?.name ?? "世界地图"}
              </h1>
              <p class="text-xs text-neutral-500">画布 · 空白处右键添加服务器，拖动行尾圆点连线建依赖</p>
            </div>
            {/* 透镜选择器：全部项目（世界视图）+ 各项目 */}
            <Show when={projects().length > 0}>
              <select
                class="rounded border border-harbor-700 bg-harbor-950 px-2 py-1 text-sm text-neutral-300"
                value={lens() ?? ""}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setView(null);
                  applyLens(v ? Number(v) : null);
                }}
              >
                <option value="">全部项目</option>
                {projects().map((p) => (
                  <option value={p.id}>{p.name}</option>
                ))}
              </select>
            </Show>
          </div>
          <div class="relative flex-1">
            <Board lens={lens} />
          </div>
        </div>
        {/* keyed：view 换对象即整体重建抽屉，等价 React 版的 key 状态重置 */}
        <Show when={view()} keyed>
          {(v) => <DrawerHost view={v} />}
        </Show>
        {/* toast/确认框/输入框宿主（应用内反馈件，替代原生弹窗） */}
        <FeedbackHost />
      </Show>
      </div>
    </UiContext.Provider>
  );
}
