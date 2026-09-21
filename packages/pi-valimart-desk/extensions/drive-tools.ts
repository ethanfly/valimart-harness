import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addDeliverables, addTaskLog, getTask, patchTask } from "../lib/gateway.mjs";
import { zoneRoot } from "../lib/drive-paths.mjs";
import { getMirror, syncDrive } from "../lib/drive-runtime.mjs";
import { isLoggedIn, loadState, saveState } from "../lib/state.mjs";

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: errText(err) }], details: { error: errText(err) }, isError: true as const };
}

function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function username() {
  const u = loadState().user?.username;
  if (!u) throw new Error("未登录公司网关");
  return u;
}

function resolveTaskId(explicit?: string) {
  if (explicit) return explicit;
  const bound = loadState().currentTaskId;
  if (!bound) throw new Error("当前没有绑定任务卡：用 /desk-task <id> 绑定，或显式传 taskId");
  return bound;
}

async function fetchAndCard(taskId: string) {
  const r = await getTask(taskId);
  const task = r.task ?? r;
  getMirror().writeTaskCard(task);
  return task;
}

export function registerDrive(pi: ExtensionAPI) {
  pi.registerCommand("desk-sync", {
    description: "同步公司盘镜像（回推个人记忆 + 拉取可见文件）",
    handler: async (_args, ctx) => {
      try {
        const r = await syncDrive();
        ctx.ui.notify(`公司盘已同步：远端 ${r.files} 个，下载 ${r.pulled}，回推 ${r.pushed}`, "info");
      } catch (err) {
        ctx.ui.notify(errText(err), "error");
      }
    },
  });

  pi.registerCommand("desk-task", {
    description: "绑定当前任务卡（/desk-task [任务ID]；不带参数查看）",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        const cur = loadState().currentTaskId;
        ctx.ui.notify(cur ? `当前任务 ${cur}` : "未绑定任务卡。用法：/desk-task tk-xxxx", "info");
        return;
      }
      try {
        const task = await fetchAndCard(id);
        saveState({ currentTaskId: task.id });
        ctx.ui.notify(`已绑定 ${task.id}「${task.title}」· ${getMirror().taskDir(task.id)}`, "info");
      } catch (err) {
        ctx.ui.notify(errText(err), "error");
      }
    },
  });

  pi.registerTool({
    name: "company_memory_write",
    label: "写公司记忆",
    description:
      "把经验/方法/证据/复盘写进公司盘记忆（Markdown）。zone=personal 写到 _office/<账号>/_memory；zone=shared 写到 _shared/_memory（员工只能追加 05-logs）。path 相对 _memory：01-projects / 02-methods / 03-evidence / 04-reviews / 05-logs / 90-system。",
    promptSnippet: "Write company memory markdown",
    promptGuidelines: ["Use company_memory_write to save reusable methods, pitfalls, and reviews into personal or shared company drive memory."],
    parameters: Type.Object({
      zone: StringEnum(["personal", "shared"] as const, { description: "personal 个人记忆；shared 公司共享" }),
      path: Type.String({ description: "相对 _memory 的路径，如 02-methods/详情页模块顺序.md" }),
      content: Type.String({ description: "Markdown 正文" }),
      append: Type.Optional(Type.Boolean({ description: "追加而不是覆盖（05-logs / 90-system 必须追加）" })),
    }),
    async execute(_id, args) {
      try {
        const rel = `${zoneRoot(args.zone, username())}/${String(args.path).replace(/^\/+/, "")}`;
        const append = !!args.append || /^(05-logs|90-system)\//.test(args.path);
        const gw = getMirror().gateway;
        const r = await gw.put(`/api/drive/file?path=${encodeURIComponent(rel)}${append ? "&append=1" : ""}`, Buffer.from(args.content, "utf8"), {
          raw: true,
          headers: { "content-type": "application/octet-stream" },
        });
        const local = getMirror().abs(rel);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        if (append) fs.appendFileSync(local, args.content);
        else fs.writeFileSync(local, args.content);
        const file = r?.file ?? {};
        return ok(`已写入公司盘 ${file.path ?? rel}（${file.size ?? ""} 字节）${append ? "（追加）" : ""}；本机镜像 ${local}`);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_memory_read",
    label: "读公司记忆",
    description: "读取公司盘记忆文件。zone=personal / shared / handbook。",
    promptSnippet: "Read a company-drive memory file",
    promptGuidelines: ["Use company_memory_read to open handbook, shared experience, or personal memory files by relative path."],
    parameters: Type.Object({
      zone: StringEnum(["personal", "shared", "handbook"] as const),
      path: Type.String({ description: "相对该区的文件路径" }),
    }),
    async execute(_id, args) {
      try {
        const rel = `${zoneRoot(args.zone, username())}/${String(args.path).replace(/^\/+/, "")}`;
        const buf = await getMirror().gateway.get(`/api/drive/file?path=${encodeURIComponent(rel)}`);
        const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : JSON.stringify(buf);
        return ok(text);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_memory_list",
    label: "列公司记忆",
    description: "列出公司盘记忆目录（personal / shared / handbook）。",
    promptSnippet: "List company-drive memory directory",
    promptGuidelines: ["Use company_memory_list to browse personal, shared, or handbook folders."],
    parameters: Type.Object({
      zone: StringEnum(["personal", "shared", "handbook"] as const),
      path: Type.Optional(Type.String({ description: "相对该区的子目录，默认根" })),
    }),
    async execute(_id, args) {
      try {
        const rel = `${zoneRoot(args.zone, username())}${args.path ? `/${String(args.path).replace(/^\/+/, "")}` : ""}`;
        const r = await getMirror().gateway.get(`/api/drive/list?path=${encodeURIComponent(rel)}`);
        const items = Array.isArray(r?.items) ? r.items : [];
        if (!items.length) return ok(`${rel}/ 为空`);
        const text = items.map((it: { isDir?: boolean; path?: string; size?: number; mtime?: string }) => `${it.isDir ? "dir" : "file"} ${it.path}${it.isDir ? "" : ` (${it.size} B, ${it.mtime})`}`).join("\n");
        return ok(text, r);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_task_read",
    label: "读任务卡",
    description: "读取任务卡：派单人/提交人/状态/任务内容/提交内容/交付物/关联进程/工作日志。不传 taskId 时读 /desk-task 绑定的任务。",
    promptSnippet: "Read a company task card",
    promptGuidelines: ["Use company_task_read for the bound task or an explicit taskId."],
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "任务 ID，如 tk-…；缺省为当前绑定任务" })),
    }),
    async execute(_id, args) {
      try {
        const task = await fetchAndCard(resolveTaskId(args.taskId));
        return ok(JSON.stringify(task, null, 2), task);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_task_log",
    label: "任务日志",
    description: "往任务卡工作日志追加一条。不传 taskId 时写当前绑定任务。",
    promptSnippet: "Append a work log line to a task card",
    promptGuidelines: ["Use company_task_log to record what changed and why on the bound task."],
    parameters: Type.Object({
      text: Type.String({ description: "日志正文（一两句话）" }),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      try {
        const id = resolveTaskId(args.taskId);
        const r = await addTaskLog(id, { text: args.text, kind: "agent", sessionId: null });
        getMirror().writeTaskCard(r.task);
        return ok(`已记录到任务 ${id} 的工作日志（共 ${r.task.log?.length ?? "?"} 条）`);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_task_update",
    label: "更新任务卡",
    description: "更新任务卡文本：submission 提交内容，content 任务内容。不传 taskId 时写当前绑定任务。",
    promptSnippet: "Update task submission or content",
    promptGuidelines: ["Use company_task_update to write the deliverable summary into submission when work is done."],
    parameters: Type.Object({
      submission: Type.Optional(Type.String({ description: "提交内容（做了什么、交了什么）" })),
      content: Type.Optional(Type.String({ description: "任务内容" })),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      try {
        const id = resolveTaskId(args.taskId);
        const patch: Record<string, unknown> = { sessionId: null };
        if (args.submission !== undefined) Object.assign(patch, { submission: args.submission, adopt: "submission" });
        if (args.content !== undefined) Object.assign(patch, { content: args.content, adopt: patch.adopt ?? "content" });
        const r = await patchTask(id, patch);
        getMirror().writeTaskCard(r.task);
        return ok(`任务 ${id} 已更新（状态 ${r.task.statusLabel ?? r.task.status}）`);
      } catch (err) {
        return fail(err);
      }
    },
  });

  pi.registerTool({
    name: "company_task_attach",
    label: "挂交付物",
    description: "把本机文件作为交付物挂到任务卡（上传到公司盘 projects/inbox/<任务ID>/）。口头完成不算完成。不传 taskId 时挂到当前绑定任务。",
    promptSnippet: "Attach local files as task deliverables",
    promptGuidelines: ["Use company_task_attach to upload real files onto the task card before claiming the work is done."],
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { description: "本机文件路径（相对当前工作目录或绝对路径）" }),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      try {
        const id = resolveTaskId(args.taskId);
        const cwd = ctx?.cwd || process.cwd();
        const files = [];
        for (const p of args.paths) {
          const full = path.resolve(cwd, p);
          const st = fs.statSync(full);
          if (!st.isFile()) throw new Error(`${p} 不是文件`);
          if (st.size > 50 * 1024 * 1024) throw new Error(`${p} 超过 50MB`);
          files.push({
            name: path.basename(full),
            dataBase64: fs.readFileSync(full).toString("base64"),
            source: "agent",
            sessionId: null,
            localPath: full,
          });
        }
        const r = await addDeliverables(id, files);
        getMirror().writeTaskCard(r.task);
        getMirror().pull().catch(() => {});
        return ok(`已挂载 ${args.paths.length} 个交付物到任务 ${id}：${(r.task.deliverables ?? []).map((d: { name?: string }) => d.name).join("、")}`);
      } catch (err) {
        return fail(err);
      }
    },
  });

}

export function companyDrivePrompt() {
  const state = loadState();
  if (!isLoggedIn(state)) return "";
  const u = state.user;
  const c = state.company;
  const drive = state.driveDir;
  const lines = [
    `## 企业交付工作台（${c?.name ?? "公司"}）`,
    `你在为 ${u.displayName || u.username}（账号 ${u.username}，${u.roleLabel ?? u.role}，${u.department ?? ""}）工作，通过公司网关使用模型，用量按人记账。`,
    `公司盘本机镜像：${drive}`,
    `- _shared/_memory/ 共享经验（全员只读；01-projects 项目、02-methods 方法、03-evidence 证据、04-reviews 复盘、05-logs 日志(追加)、90-system 系统/规定(追加)）`,
    `- _shared/handbook/ 岗位手册 / 公司技能手册：地图上的 how 已经是结论，有就按那条做，没有就说明没有。`,
    `- _office/${u.username}/_memory/ 你的个人记忆（跟人走）。值得复用的做法、踩过的坑，用 company_memory_write 写进去。`,
    `- projects/inbox/<任务ID>/ 任务交付物；每个任务目录里的 _task-card.md / _worklog.md 是任务卡与工作日志。`,
    `- 第四层是检索，不是知识库本身：开工前用 company_knowledge 问「公司里有没有人做过」，只拿到谁/何时/在哪，不拷贝别人的会话；细节去读那张任务卡。`,
    `规则：口头完成不算完成——交付必须是文件，用 company_task_attach 挂到任务卡；做完把结论写进提交内容（company_task_update），过程记进工作日志（company_task_log）。`,
  ];
  const taskId = state.currentTaskId;
  if (taskId) {
    const dir = getMirror().taskDir(taskId);
    lines.push("", `当前绑定任务卡 ${taskId}。任务格子（本机目录）：${dir}`, `- 交付物写到这个目录，再用 company_task_attach 挂卡。`);
    try {
      lines.push("", fs.readFileSync(path.join(dir, "_task-card.md"), "utf8"));
    } catch {
      /* 尚未同步 */
    }
  }
  return lines.join("\n");
}

export async function syncDriveQuiet() {
  if (!isLoggedIn()) return null;
  try {
    return await syncDrive();
  } catch {
    return null;
  }
}
