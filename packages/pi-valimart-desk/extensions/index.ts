/**
 * valimart pi desk（惠利玛）：公司网关当模型路由，补上 CLI 没有的登录 / 知识检索 / 任务卡。
 *
 * /login valimart 或 /desk-login
 * /model 选 valimart/<公司目录里的模型>
 */
import os from "node:os";
import { StringEnum, type OAuthCredentials, type OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverGateways } from "../lib/discover.mjs";
import { gatewayOptions, gatewayUrlFromChoice, MANUAL_GATEWAY_LABEL, suggestedGatewayUrl } from "../lib/gateway-choice.mjs";
import {
  fetchMe,
  GatewayError,
  getTask,
  isLoggedIn,
  listTasks,
  loadState,
  login,
  logout,
  normalizeGatewayUrl,
  searchKnowledge,
} from "../lib/gateway.mjs";
import { setDriveLogSink } from "../lib/drive-runtime.mjs";
import { DEFAULT_GATEWAY_URL, parseDeskLoginArgs } from "../lib/login-args.mjs";
import { toPiModels, v1BaseUrl } from "../lib/models.mjs";
import { publicView, saveState } from "../lib/state.mjs";
import { createValimartHeader, PRODUCT_NAME } from "./header.ts";
import { companyDrivePrompt, registerDrive, syncDriveQuiet } from "./drive-tools.ts";

const PROVIDER_ID = "valimart";

type DriveUi = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string): void;
};

/** TUI 里 console.log 是裸 stdout，字会落进输入框。启动时例行同步只改状态栏；后台有推拉才弹窗。 */
let driveUi: DriveUi | undefined;

function applyDriveSync(ui: DriveUi | undefined, sync: { files: number; pulled?: number; pushed?: number } | null, notifyOnChange = false) {
  if (!sync || !ui) return;
  ui.setStatus("valimart", `${formatStatus()} · 盘 ${sync.files}`);
  const pulled = sync.pulled ?? 0;
  const pushed = sync.pushed ?? 0;
  if (notifyOnChange && (pulled || pushed)) {
    ui.notify(`公司盘已同步：远端 ${sync.files} 个，下载 ${pulled}，回推 ${pushed}`, "info");
  }
}

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** 发现失败（无网卡 / 权限）不能挡住登录：当作「没发现到网关」，退回手填。 */
async function safeDiscover() {
  try {
    return await discoverGateways();
  } catch {
    return [];
  }
}

/** OAuth 那条路只有单行输入框（callbacks.onPrompt 不支持列表）：先把发现的地址填成默认值，回车即用。 */
async function suggestGatewayUrl(current = loadState()) {
  return suggestedGatewayUrl(await safeDiscover(), current.gatewayUrl || DEFAULT_GATEWAY_URL);
}

/**
 * /desk-login 的网关这一步：先自动发现并列出可选，发现不到才让手填。
 * 返回 null = 用户取消；discovered = 地址来自发现结果（失败时也值得记下，免得重打一遍）。
 */
async function promptGatewayUrl(ctx: { ui: { notify: Function; select: Function; input: Function } }, current = loadState()) {
  const fallback = current.gatewayUrl || DEFAULT_GATEWAY_URL;
  ctx.ui.notify("正在寻找公司网关…", "info");
  const options = gatewayOptions(await safeDiscover(), { manual: MANUAL_GATEWAY_LABEL });
  if (options.some((o) => o.url)) {
    const picked = await ctx.ui.select("选择公司网关", options.map((o) => o.label));
    if (picked === undefined) return null;
    const url = gatewayUrlFromChoice(picked, options);
    if (url) return { url, discovered: true };
  }
  const typed = await ctx.ui.input("公司网关地址", fallback);
  if (typed === undefined) return null;
  return { url: String(typed).trim() || fallback, discovered: false };
}

function catalogModels(state = loadState()) {
  const baseUrl = v1BaseUrl(state.gatewayUrl || DEFAULT_GATEWAY_URL);
  return toPiModels(state.models ?? [], { baseUrl });
}

function registerGatewayProvider(pi: ExtensionAPI) {
  const state = loadState();
  const baseUrl = v1BaseUrl(state.gatewayUrl || DEFAULT_GATEWAY_URL);
  const models = catalogModels(state);
  pi.unregisterProvider(PROVIDER_ID);
  pi.registerProvider(PROVIDER_ID, {
    name: PRODUCT_NAME,
    baseUrl,
    api: "openai-completions",
    apiKey: state.gatewayToken || undefined,
    authHeader: true,
    ...(models.length ? { models } : {}),
    async refreshModels() {
      if (!isLoggedIn()) return catalogModels();
      try {
        const next = await fetchMe();
        return catalogModels(next);
      } catch (err) {
        if (err instanceof GatewayError && (err.status === 401 || err.code === "not_logged_in")) {
          saveState({ needsRelogin: true, lastError: err.message });
        }
        return catalogModels();
      }
    },
    oauth: {
      name: `${PRODUCT_NAME} 公司网关`,
      isSubscription: true,
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const current = loadState();
        const suggested = await suggestGatewayUrl(current);
        const urlRaw =
          (await callbacks.onPrompt({
            message: `网关地址（回车 = ${suggested}）`,
          })) || suggested;
        const url = normalizeGatewayUrl(urlRaw) || DEFAULT_GATEWAY_URL;
        const username = (await callbacks.onPrompt({ message: "公司账号" })).trim();
        const password = await callbacks.onPrompt({ message: "密码" });
        callbacks.onProgress?.("正在登录公司网关…");
        const next = await login({
          gatewayUrl: url,
          username,
          password,
          device: `pi-agent (${os.hostname()})`,
        });
        registerGatewayProvider(pi);
        return {
          access: next.gatewayToken,
          refresh: next.sessionToken,
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (credentials.refresh) saveState({ sessionToken: credentials.refresh, gatewayToken: credentials.access });
        const next = await fetchMe();
        registerGatewayProvider(pi);
        return {
          access: next.gatewayToken || credentials.access,
          refresh: next.sessionToken || credentials.refresh,
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials) {
        return credentials.access;
      },
    },
  });
}

function formatStatus(state = loadState()) {
  if (!isLoggedIn(state)) return state.needsRelogin ? "valimart: 需重新登录" : "valimart: 未登录";
  const who = state.user?.displayName || state.user?.username || "已登录";
  const company = state.company?.name ? `@${state.company.name}` : "";
  return `valimart: ${who}${company}`;
}

function summarizeQuota(quota: unknown) {
  if (!Array.isArray(quota) || quota.length === 0) return "额度：无";
  return quota
    .map(
      (q: {
        label?: string;
        kind?: string;
        usedCny?: unknown;
        limitCny?: unknown;
        usedTokens?: unknown;
        limitTokens?: unknown;
        usedPct?: unknown;
        refreshAt?: string;
      }) => {
        const name = q.label || "总额度";
        const used = q.kind === "tokens" ? q.usedTokens : q.usedCny;
        const limit = q.kind === "tokens" ? q.limitTokens : q.limitCny;
        const unit = q.kind === "tokens" ? "token" : "元";
        const pct = q.usedPct != null ? ` ${q.usedPct}%` : "";
        const refresh = q.refreshAt ? ` 刷新 ${q.refreshAt}` : "";
        return `${name} ${used}/${limit} ${unit}${pct}${refresh}`;
      },
    )
    .join("\n");
}

function taskSummary(task: Record<string, unknown>) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee ?? task.assigneeName,
    reviewer: task.reviewer,
    updatedAt: task.updatedAt ?? task.updated_at,
  };
}

export default function valimartPiDesk(pi: ExtensionAPI) {
  registerGatewayProvider(pi);
  registerDrive(pi);
  let driveTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      driveUi = ctx.ui;
      setDriveLogSink(() => {});
      ctx.ui.setTitle(PRODUCT_NAME);
      ctx.ui.setHeader((_tui, theme) => createValimartHeader(theme));
    } else {
      driveUi = undefined;
      setDriveLogSink(null);
    }
    ctx.ui.setStatus("valimart", formatStatus());
    if (!isLoggedIn()) return;
    try {
      const next = await fetchMe();
      registerGatewayProvider(pi);
      ctx.ui.setStatus("valimart", formatStatus(next));
    } catch (err) {
      saveState({ needsRelogin: true, lastError: errText(err) });
      ctx.ui.setStatus("valimart", formatStatus());
    }
    const sync = await syncDriveQuiet();
    applyDriveSync(ctx.ui, sync);
    if (driveTimer) clearInterval(driveTimer);
    driveTimer = setInterval(() => {
      syncDriveQuiet()
        .then((r) => applyDriveSync(driveUi, r, true))
        .catch(() => {});
    }, 30_000);
  });

  pi.on("session_shutdown", () => {
    if (driveTimer) {
      clearInterval(driveTimer);
      driveTimer = undefined;
    }
    driveUi = undefined;
    setDriveLogSink(null);
  });

  pi.on("before_agent_start", async (event) => {
    const state = loadState();
    if (!isLoggedIn(state) || !event.systemPromptOptions?.sections) return;
    const who = state.user?.displayName || state.user?.username || "";
    const company = state.company?.name || "公司";
    event.systemPromptOptions.sections.company = companyDrivePrompt() || [
      `你通过 valimart harness 公司网关干活（账号 ${who}，公司「${company}」）。`,
      "模型密钥只在网关。额度按人按周记账，满了会 429。",
      "开工前用 company_knowledge 问「公司里有没有人做过」。",
      "口头说做完了不算完成：产物要能对上任务卡。",
    ].join("\n");
  });

  pi.registerCommand("desk-login", {
    description: "登录公司网关（先自动发现，没有才手填；也可 /desk-login [网关URL] [账号]）",
    handler: async (args, ctx) => {
      const parsed = parseDeskLoginArgs(args);
      const current = loadState();
      let url = parsed.url;
      let username = parsed.username;
      let password = parsed.password;
      if (!url || !username || !password) {
        if (!ctx.hasUI) {
          ctx.ui.notify("非交互登录请设 DESK_GATEWAY_URL / DESK_GATEWAY_USER / DESK_GATEWAY_PASSWORD 后执行 /desk-login", "error");
          return;
        }
        // 命令行 / 环境变量给了地址就不打扰：只有要问地址时才去发现网关
        if (!url) {
          const picked = await promptGatewayUrl(ctx, current);
          if (!picked) {
            ctx.ui.notify("已取消登录", "warning");
            return;
          }
          url = picked.url;
          if (picked.discovered && url !== current.gatewayUrl) saveState({ gatewayUrl: url });
        }
        username = username || (await ctx.ui.input("公司账号", current.user?.username || "")) || "";
        password = password || (await ctx.ui.input("密码")) || "";
      }
      if (!username || !password) {
        ctx.ui.notify("已取消登录", "warning");
        return;
      }
      try {
        const next = await login({ gatewayUrl: url, username, password, device: `pi-agent (${os.hostname()})` });
        registerGatewayProvider(pi);
        ctx.ui.setStatus("valimart", formatStatus(next));
        const first = catalogModels(next)[0];
        if (first) {
          const model = ctx.modelRegistry.find(PROVIDER_ID, first.id);
          if (model) await pi.setModel(model);
        }
        const sync = await syncDriveQuiet();
        ctx.ui.notify(
          `已登录 ${next.user?.displayName || next.user?.username} · ${catalogModels(next).length} 个模型${sync ? ` · 公司盘 ${sync.files} 文件` : ""}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(errText(err), "error");
      }
    },
  });

  pi.registerCommand("desk-logout", {
    description: "登出公司网关",
    handler: async (_args, ctx) => {
      try {
        await logout();
      } catch {
        /* still clear locally */
      }
      registerGatewayProvider(pi);
      ctx.ui.setStatus("valimart", formatStatus());
      ctx.ui.notify("已登出公司网关", "info");
    },
  });

  pi.registerCommand("desk-status", {
    description: "查看公司网关登录态与额度",
    handler: async (_args, ctx) => {
      try {
        if (isLoggedIn()) {
          const next = await fetchMe();
          registerGatewayProvider(pi);
          ctx.ui.setStatus("valimart", formatStatus(next));
        }
      } catch (err) {
        ctx.ui.notify(errText(err), "error");
      }
      const view = publicView();
      const lines = [
        view.loggedIn ? `已登录 ${view.user?.displayName || view.user?.username}` : "未登录",
        `网关 ${view.gatewayUrl}`,
        view.company?.name ? `公司 ${view.company.name}` : "",
        view.defaultModel ? `默认模型 ${view.defaultModel}` : "",
        view.models?.length ? `目录 ${view.models.join(", ")}` : "",
        summarizeQuota(loadState().quota),
        view.lastError ? `上次错误：${view.lastError}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), view.loggedIn ? "info" : "warning");
    },
  });

  pi.registerCommand("desk-discover", {
    description: "在局域网寻找公司网关",
    handler: async (_args, ctx) => {
      ctx.ui.notify("正在寻找公司网关…", "info");
      const options = gatewayOptions(await safeDiscover(), { manual: "", withSource: true });
      if (!options.length) {
        ctx.ui.notify("没有发现网关。本机可试 http://127.0.0.1:8790，或手动 /desk-login", "warning");
        return;
      }
      const picked = await ctx.ui.select("选择公司网关", options.map((o) => o.label));
      const url = gatewayUrlFromChoice(picked, options);
      if (!url) return;
      saveState({ gatewayUrl: url });
      registerGatewayProvider(pi);
      ctx.ui.notify(`已记下网关 ${url}，接着 /desk-login`, "info");
    },
  });

  pi.registerTool({
    name: "company_whoami",
    label: "公司账号",
    description: "查看当前公司网关登录账号、公司名和本周额度。密钥不会返回。",
    promptSnippet: "Current company-gateway login and weekly quota",
    promptGuidelines: ["Use company_whoami when the user asks who they are logged in as, which company gateway, or remaining quota."],
    parameters: Type.Object({}),
    async execute() {
      try {
        const next = await fetchMe();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(publicView(next), null, 2) }],
          details: publicView(next),
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: errText(err) }], details: { error: errText(err) }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "company_knowledge",
    label: "公司知识",
    description:
      "企业知识库第四层通道。开工前先问「公司里有没有人做过」。在岗位手册 / 共享经验 / 个人记忆 / 相关任务格子和任务卡里按关键词搜，只返回谁、什么时候、在哪、一小段上下文；不拷贝会话。细节用 company_task_read 或读公司盘文件。",
    promptSnippet: "Search company knowledge (who / when / where)",
    promptGuidelines: [
      "Use company_knowledge before inventing company process or claiming nobody has done similar work.",
      "company_knowledge returns snippets only; follow the path or task id for details.",
    ],
    parameters: Type.Object({
      q: Type.Optional(Type.String({ description: "检索词" })),
      query: Type.Optional(Type.String({ description: "检索词（与 q 相同）" })),
      limit: Type.Optional(Type.Number({ description: "最多条数，默认 20" })),
      kinds: Type.Optional(Type.String({ description: "可选过滤：handbook,shared,personal,task,skills，逗号分隔" })),
    }),
    async execute(_id, params) {
      try {
        const q = String(params.query || params.q || "").trim();
        const result = await searchKnowledge(q, { limit: params.limit, kinds: params.kinds });
        const hits = Array.isArray(result?.hits) ? result.hits : [];
        if (!hits.length) {
          return {
            content: [{ type: "text" as const, text: `公司里没有人做过「${result.query ?? q}」（扫描了 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）。` }],
            details: result,
          };
        }
        const lines = hits.map((h: Record<string, unknown>, i: number) => {
          const head = `${i + 1}. [${h.kindLabel ?? h.kind}] ${h.title ?? ""}${h.statusLabel ? `（${h.statusLabel}）` : ""}`;
          const meta = [h.who ? `谁：${h.who}` : null, `何时：${h.when}`, `在哪：${h.path}`, h.taskId ? `任务卡：${h.taskId}` : null].filter(Boolean).join(" · ");
          return `${head}\n   ${meta}\n   ${h.snippet ?? ""}`;
        });
        const text = `公司里做过「${result.query}」的记录 ${hits.length} 条（扫描 ${result.scanned?.files ?? 0} 个文件、${result.scanned?.tasks ?? 0} 张任务卡）：\n${lines.join("\n")}`;
        return { content: [{ type: "text" as const, text }], details: result };
      } catch (err) {
        return { content: [{ type: "text" as const, text: errText(err) }], details: { error: errText(err) }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "company_tasks",
    label: "任务卡",
    description: "列出或查看公司任务卡（进行中 / 待审 / 待终审 / 通过 / 驳回）。只读。交活用 company_task_submit，初审 company_task_review，终审 company_task_final。",
    promptSnippet: "List or read company task cards",
    promptGuidelines: [
      "Use company_tasks to list visible task cards or fetch one by id.",
      "Do not claim a task is done unless status is approved. To submit for review use company_task_submit, not this tool.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get"] as const, { description: "list 列出可见任务；get 查看一张" }),
      id: Type.Optional(Type.String({ description: "get 时的任务 id" })),
      status: Type.Optional(
        StringEnum(["draft", "pending_review", "pending_final", "approved", "rejected"] as const, {
          description: "list 时按状态过滤",
        }),
      ),
    }),
    async execute(_id, params) {
      try {
        if (params.action === "get") {
          if (!params.id) {
            return { content: [{ type: "text" as const, text: "get 需要任务 id" }], details: {}, isError: true };
          }
          const result = await getTask(params.id);
          const task = result.task ?? result;
          return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }], details: task };
        }
        const result = await listTasks();
        let tasks = Array.isArray(result.tasks) ? result.tasks : [];
        if (params.status) tasks = tasks.filter((t: { status?: string }) => t.status === params.status);
        const rows = tasks.map(taskSummary);
        const text = rows.length
          ? rows.map((t: { id?: string; title?: string; status?: string }) => `- ${t.id}  [${t.status}]  ${t.title}`).join("\n")
          : "没有可见任务卡";
        return { content: [{ type: "text" as const, text }], details: { tasks: rows, statuses: result.statuses } };
      } catch (err) {
        return { content: [{ type: "text" as const, text: errText(err) }], details: { error: errText(err) }, isError: true };
      }
    },
  });
}
