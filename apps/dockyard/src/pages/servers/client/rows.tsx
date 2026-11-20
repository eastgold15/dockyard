/** @jsxImportSource solid-js */
/**
 * servers 页的行与面板组件：服务器行、TOFU 信任提示、镜像源面板、添加服务器弹窗。
 * 纯展示 + 回调，状态与请求编排在 app.tsx（一个页面目录内的 L5 client）。
 */
import { createSignal } from "solid-js";
import type { Server } from "../schema";
import { parseMirrors } from "../servers.mirrors";
import { field } from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";
import {
  Badge,
  Button,
  Field,
  Modal,
  TextInput,
} from "@/shared/solid-ui/index";

/** 本机/远程徽章（部署通道分界线：以 builtin 列为准） */
function ScopeBadge(props: { server: Server }) {
  return props.server.builtin ? (
    <Badge label="本机" tone="ok" />
  ) : (
    <Badge label="远程" tone="muted" />
  );
}

function DockerBadge(props: { server: Server }) {
  if (props.server.dockerStatus === "ok")
    return (
      <Badge
        label={`docker ${props.server.dockerVersion ?? "ok"}`}
        tone="ok"
      />
    );
  if (props.server.dockerStatus === "missing")
    return <Badge label="无 docker" tone="err" />;
  return <Badge label="未检测" tone="muted" />;
}

export function ServerRow(props: {
  server: Server;
  message?: string;
  mirrorsOpen: boolean;
  busy: boolean;
  onToggleMirrors: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onResources: () => void;
  onDelete: () => void;
  onSaveMirrors: (text: string) => void;
}) {
  const server = () => props.server;
  return (
    <div class="border-b border-harbor-800/60">
      <div class="flex min-h-12 flex-wrap items-center gap-4 px-4 hover:bg-harbor-900 sm:px-6">
        <span class="text-sm font-medium text-neutral-100">{server().name}</span>
        <ScopeBadge server={server()} />
        {server().builtin ? <Badge label="内置" tone="muted" /> : null}
        <span class="mono text-xs text-neutral-500">
          {server().builtin
            ? "本地进程直连"
            : `${server().user}@${server().host}:${server().port}`}
        </span>
        <span class="ml-auto">
          <DockerBadge server={server()} />
        </span>
        <Button
          label="共享资源"
          variant="ghost"
          size="sm"
          onClick={props.onResources}
        />
        <Button
          label="检测"
          variant="ghost"
          size="sm"
          disabled={props.busy}
          onClick={props.onCheck}
        />
        {/* 本机不提供「安装 docker」：安装方式随发行版/权限，检测结果里已说明原因 */}
        {!server().builtin && server().dockerStatus === "missing" ? (
          <Button
            label="安装 docker"
            size="sm"
            disabled={props.busy}
            onClick={props.onInstall}
          />
        ) : null}
        {server().builtin ? null : (
          <Button
            label="镜像源"
            variant="ghost"
            size="sm"
            onClick={props.onToggleMirrors}
          />
        )}
        {server().builtin ? null : (
          <Button
            label="删除"
            variant="danger"
            size="sm"
            disabled={props.busy}
            onClick={props.onDelete}
          />
        )}
      </div>
      {server().builtin ? null : (
        <MirrorPanel
          server={server()}
          open={props.mirrorsOpen}
          busy={props.busy}
          onSave={props.onSaveMirrors}
        />
      )}
      {props.message ? (
        <pre class="mono mx-4 mb-3 max-h-40 overflow-auto rounded bg-harbor-950 p-2 text-xs whitespace-pre-wrap text-neutral-400 sm:mx-6">
          {props.message}
        </pre>
      ) : null}
    </div>
  );
}

function MirrorPanel(props: {
  server: Server;
  open: boolean;
  busy: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = createSignal(parseMirrors(props.server).join("\n"));
  if (!props.open) return null;
  return (
    <div class="border-t border-harbor-800/60 bg-harbor-950 px-4 py-3 sm:px-6">
      <div class="flex max-w-xl flex-col gap-2">
        <Field label="Docker 镜像源（每行一个，docker.io 加速地址）">
          <textarea
            class={cx(field(), "mono min-h-20 py-2 text-xs")}
            rows={3}
            value={text()}
            placeholder={"https://docker.1ms.run\nhttps://docker.m.daocloud.io"}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Field>
        <p class="text-xs text-neutral-500">
          应用会把列表合并进远端 /etc/docker/daemon.json（追加不覆盖），并重启
          dockerd——会短暂中断这台服务器上的运行中容器。
        </p>
        <div>
          <Button
            label="保存并应用"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onSave(text())}
          />
        </div>
      </div>
    </div>
  );
}

/** TOFU 确认：首次连接展示指纹，用户显式信任 */
export function TrustPrompt(props: {
  server: Server;
  fingerprint: string;
  algorithm: string;
  busy: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="border-b border-brass-600/40 bg-brass-500/5 px-4 py-4 sm:px-6">
      <div class="text-sm font-medium text-brass-500">
        确认主机指纹 — {props.server.name}
      </div>
      <div class="mt-1 text-xs text-neutral-400">
        首次连接 <span class="mono">{props.server.host}</span>，请核对{" "}
        {props.algorithm} 指纹：
      </div>
      <code class="mono mt-2 block rounded bg-harbor-950 p-2 text-xs break-all text-brass-500">
        {props.fingerprint}
      </code>
      <div class="mt-3 flex gap-2">
        <Button
          label="信任并继续"
          size="sm"
          disabled={props.busy}
          onClick={props.onTrust}
        />
        <Button
          label="取消"
          variant="ghost"
          size="sm"
          onClick={props.onCancel}
        />
      </div>
    </div>
  );
}

export interface AddServerBody {
  name: string;
  host: string;
  port: number;
  user: string;
  authType: "key" | "password" | "agent";
  keyPath?: string;
  password?: string;
  registryMirrors?: string;
}

const pickAuthType = (raw: string): AddServerBody["authType"] =>
  raw === "password" ? "password" : raw === "agent" ? "agent" : "key";

/** 添加服务器弹窗：表单由客户端组装，校验由服务端 typebox + ServiceError 负责 */
export function AddServerModal(props: {
  onClose: () => void;
  onSubmit: (body: AddServerBody) => void;
}) {
  const submit = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const port = Number(fd.get("port") ?? 22) || 22;
    const text = (key: string) => String(fd.get(key) ?? "").trim();
    props.onSubmit({
      name: text("name"),
      host: text("host"),
      port,
      user: text("user"),
      authType: pickAuthType(String(fd.get("authType") ?? "key")),
      keyPath: text("keyPath") || undefined,
      password: text("password") || undefined,
      registryMirrors: text("registryMirrors") || undefined,
    });
  };

  return (
    <Modal
      open
      title="添加服务器"
      sub="远程 SSH 主机；本机由程序自动认领"
      width="md"
      onClose={props.onClose}
    >
      <form
        class="grid max-w-3xl grid-cols-1 gap-3 p-5 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget);
        }}
      >
        <TextInput label="名称" name="name" placeholder="生产机" required />
        <TextInput
          label="主机"
          name="host"
          placeholder="192.168.1.10（本机由程序自动认领）"
          required
        />
        <TextInput label="端口" name="port" type="number" value="22" />
        <TextInput label="用户" name="user" placeholder="root" required />
        <Field label="认证方式">
          <select class={field()} name="authType">
            <option value="key">私钥文件</option>
            <option value="agent">ssh-agent</option>
            <option value="password">密码</option>
          </select>
        </Field>
        <TextInput
          label="私钥路径（key 时）"
          name="keyPath"
          placeholder="~/.ssh/id_ed25519"
        />
        <TextInput label="密码（password 时）" name="password" type="password" />
        <div class="col-span-1 sm:col-span-2">
          <Field label="Docker 镜像源（每行一个，可选；添加后可在行内「保存并应用」）">
            <textarea
              class={cx(field(), "mono min-h-16 py-2 text-xs")}
              name="registryMirrors"
              rows={2}
              placeholder={"https://docker.1ms.run\nhttps://docker.m.daocloud.io"}
            />
          </Field>
        </div>
        <div class="col-span-1 sm:col-span-2">
          <Button label="添加" type="submit" />
        </div>
      </form>
    </Modal>
  );
}
