# 2026-11-23 侧栏会话列表空白：补子槽 hook 声明与容器契约

## 起因

用户反馈网关上的 `0.1.0+0.2.2-rc.5.20261120-1040.232a348d` 仍然「会话消失」。11-20 的修复（`ed07e33`）只验过构建、CI 和「bundle 里有修复代码」，没跑真实界面。

## 排查

- 临时端口起 desk 内核，进程内抓带 token 的 `dsh web:` 地址（不落终端），系统 Chrome 打开：`.dk-side-body` 里没有 `[data-sidebar-workspace-header]`，会话区整块空白（页面快照里侧栏只剩品牌、会话/任务切换和底部账号）。
- 读 `@deepseek-ai/dsh-client-ui-renderer` 的 `scoped-slots.tsx`：`cachedSlotInject(face)` 只从**子槽声明的 `inject.hooks`** 里收集函数型工厂（`slotHookFactories`），渲染时 `bindSlotHookFactories(factories, standard, hookContext)` 才把 `renderSlot` 第三参的 `hookContext` 喂进去。声明上没有工厂时，`hookContext` 直接被忽略。
- 官方 `dsh-client-ui-sidebar/src/client/index.ts`：`children['sidebar.workspaces'] = { kind: 'single', scope: 'root', inject: SIDEBAR_SECTION_INJECT }`，`SIDEBAR_SECTION_INJECT = { hooks: { sectionScroller: (_standard, { useSectionScroller }) => useSectionScroller } }`。desk-ui 的子槽声明缺这一项。
- 第一次尝试把 `hooks` 写进根槽 `inject`（`DeskSidebar` 的注入）：真内核 e2e 仍失败——根槽 inject 只变成 `DeskSidebar` 的 props，不会下发给子槽。
- 容器契约：`WorkspaceBrowser.module.css` 的 `.root:not(.rail)` 用 `max-height: 100cqh` / `height: 100cqh`，列表区用 `@container scroll-state(scrollable: bottom)`；官方 `SidebarRoot.module.css` 的 `.scrollRegion` 是 `container-type: size`，`.scrollArea` 是 `container-type: scroll-state`。desk 原来的 `.dk-side-body` 两者都没有。

## 改动

- `plugins/desk-ui/src/client/index.jsx`：模块级 `SIDEBAR_SECTION_INJECT`，挂到 `sidebar` 注册里 `children['sidebar.workspaces'].inject`。
- `plugins/desk-ui/src/client/sidebar.jsx`：展开态加外层 `.dk-side-region`，`.dk-side-body` 挂 `bindViewportRef` 与 `data-sidebar-scrollport`，任务列表也放进这个视口。
- `plugins/desk-ui/src/client/styles.css`：`.dk-side-region { container-type: size }`；`.dk-side-body` 改 `overflow-y: auto` + `container-type: scroll-state`，隐藏滚动条。
- `e2e/desk-flow.smoke.spec.js`：新增可选真内核用例（`DESK_SMOKE_URL`），断言 header / `treeitem` 可见、两层 `container-type`、无槽崩溃。

## 验证

- 新 e2e：先 `git stash` 掉修复、重打 bundle 跑一次，失败（`[data-sidebar-workspace-header]` not found）；恢复修复后通过（1 passed）。
- 真实界面探针（展开 → 滚轮 → 收起 → 任务页 → 切回会话）：零 pageerror、零 console.error；展开态 `.dk-side-region` 是 `size`，`.dk-side-body` 是 `scroll-state`；任务页列表正常。
- 会话完整性：`~/.dsh/sessions` 共 2 个会话。`团队` 下的会话可见；`default-workspace` 的 `session-8db41613` 只有头信息（没有 `turn/start`，`blank`），官方 `ui-workspace` `tree.ts` 对 `blank && id !== current` 返回不可见，属于设计行为。
- `npm test`：707 项，701 pass / 3 fail / 3 skip。3 个失败（`mixed-scheduler` 工作区写锁、`npm-cli` PATH、`voice-runtime` 空格路径）在 stash 掉改动后单跑同样失败，是既有 Linux 问题。
