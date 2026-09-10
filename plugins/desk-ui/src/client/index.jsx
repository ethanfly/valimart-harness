/**
 * @company-desk/desk-ui · 浏览器端插件入口。
 * 取代 ui-layout / ui-sidebar / ui-brand-official：THE DIVA 外壳、会话/任务侧栏、任务卡面板、公司设置页、登录遮罩。
 */
import css from './styles.css'
import { DeskFrame, DeskLayoutController, ThemePresenter } from './layout.jsx'
import { DeskSidebar, DeskUserSettingsTrigger } from './sidebar.jsx'
import { AccountSection, ColleaguesSection, DesktopSection, KnowledgeSection, PersonnelSection, QuickInferenceSection, SubscriptionSection } from './settings.jsx'
import { MixedSection } from './mixed-settings.jsx'
import { makeMixedChip } from './mixed-mode.jsx'
import { makeMixedRunPanel } from './mixed-run-panel.jsx'
import { startMixedPolling } from './mixed-store.js'
import { ImageGenSection, makeImageChip } from './image-gen.jsx'
import { startPolling, loadPeople } from './api.js'
import { deskStore } from './store.js'
import { makeFileChip } from './composer.jsx'
import { SessionMarkdown } from './markdown.jsx'
import { Logotype, PRODUCT_NAME, markMask } from './brand.jsx'

/** 空会话页中央的品牌字标（填 conversation.hero.brand.mark 槽；官方标题与「预览版」徽标由样式隐藏）。 */
function HeroWordmark() {
  return (
    <span className="dk-hero-wordmark">
      <Logotype size={44} />
    </span>
  )
}

export const name = 'desk-ui'
export const inject = ['slots', 'theme', 'sessions', 'workspaces']

export function apply(ctx) {
  ctx.slots.inject('conversation.assistant.markdown', () => ctx.slots.register({
    name: 'conversation.assistant.markdown',
  }, SessionMarkdown))
  // ---- 样式 ----
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-plugin', '@company-desk/desk-ui')
    el.textContent = css
    document.head.append(el)
    return () => el.remove()
  }, 'desk-ui: styles')

  // The export plugin owns its click handler, progress state and dialog.
  // Add a tooltip to its icon-only presentation without replacing the button.
  ctx.effect(() => {
    const selector = '[data-slot="conversation.session.header.utilities"] button[class*="_sessionLogButton"]'
    const label = '下载会话日志'
    const sync = () => {
      for (const button of document.querySelectorAll(selector)) {
        if (!button.hasAttribute('title')) button.setAttribute('title', label)
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const button of document.querySelectorAll(selector)) {
        if (button.getAttribute('title') === label) button.removeAttribute('title')
      }
    }
  }, 'desk-ui: session log tooltip')

  // ---- 窗口标题：官方写死 "DeepSeek Harness"，改成 valimart harness ----
  ctx.effect(() => {
    const PRODUCT = PRODUCT_NAME
    const STOCK = ['DeepSeek Harness', 'THE DIVA']
    let applying = false
    const fix = () => {
      if (applying) return
      let next = document.title
      for (const s of STOCK) if (next.includes(s)) next = next.replaceAll(s, PRODUCT)
      if (next !== document.title) {
        applying = true
        document.title = next
        applying = false
      }
    }
    fix()
    const titleEl = document.querySelector('title') ?? document.head.appendChild(document.createElement('title'))
    const mo = new MutationObserver(fix)
    mo.observe(titleEl, { childList: true, characterData: true, subtree: true })
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const c = canvas.getContext('2d')
    c.fillStyle = '#111'
    c.beginPath()
    c.roundRect(0, 0, 64, 64, 14)
    c.fill()
    const img = new Image()
    img.onload = () => {
      c.fillStyle = '#fff'
      c.globalCompositeOperation = 'source-over'
      const s = 40
      c.drawImage(img, (64 - s) / 2, (64 - s) / 2, s, s)
      icon.href = canvas.toDataURL('image/png')
    }
    const maskSrc = (markMask.maskImage || '').replace(/^url\(["']?/, '').replace(/["']?\)$/, '')
    img.src = maskSrc
    const icon = document.createElement('link')
    icon.rel = 'icon'
    icon.type = 'image/png'
    const stockIcons = [...document.querySelectorAll('link[rel~="icon"]')]
    for (const el of stockIcons) el.remove()
    document.head.append(icon)
    return () => {
      mo.disconnect()
      icon.remove()
      for (const el of stockIcons) document.head.append(el)
    }
  }, 'desk-ui: document title')

  // ---- ctx.layout 服务 + 根框架 ----
  const layout = new DeskLayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRoot = ctx.slots.register(
      {
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          conversation: { kind: 'single', scope: 'session-maybe' },
          details: { kind: 'single', scope: 'session' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
        inject: () => ({ ctx }),
      },
      DeskFrame,
    )
    return () => {
      disposeRoot()
      disposeService()
    }
  }, 'desk-ui: layout service + root frame')

  // ---- 主题呈现（移植自 ui-layout）----
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => presenter.apply(snapshot))
    return () => {
      off()
      presenter.dispose()
    }
  }, 'desk-ui: theme presenter')

  // ---- 侧栏 ----
  ctx.effect(
    () =>
      ctx.slots.register(
        {
          name: 'sidebar',
          children: {
            'sidebar.brand.mark': { kind: 'single', scope: 'root' },
            'sidebar.brand.name': { kind: 'single', scope: 'root' },
            'sidebar.workspaces': { kind: 'single', scope: 'root' },
            'sidebar.settings': { kind: 'single', scope: 'root' },
            'sidebar.footer.action': { kind: 'list', scope: 'root' },
          },
          inject: () => ({
            // 内核 0.1.2-rc.1 的 UI 工作区服务叫 uiWorkspace（ctx.workspaces 是数据服务，没有 startSession）。
            startSession: (workspaceId) => (ctx.get('uiWorkspace') ?? ctx.workspaces).startSession(workspaceId),
            toggleSidebar: () => layout.toggleSidebar(),
          }),
        },
        DeskSidebar,
      ),
    'desk-ui: sidebar registration',
  )

  // ---- 设置页：账号 / 同事 / 人员 / 快速推理 / 订阅 ----
  ctx.effect(
    () => ctx.slots.inject('settings.trigger', () => ctx.slots.register({ name: 'settings.trigger', priority: -10 }, DeskUserSettingsTrigger)),
    'desk-ui: account settings trigger',
  )
  const sections = [
    { id: 'desk-account', order: 2, label: '账号', component: AccountSection },
    { id: 'desk-colleagues', order: 5, label: '同事', component: ColleaguesSection },
    { id: 'desk-personnel', order: 25, label: '人员', component: PersonnelSection },
    { id: 'desk-quick', order: 30, label: '快速推理', component: QuickInferenceSection },
    { id: 'desk-subscription', order: 35, label: '订阅', component: SubscriptionSection },
    { id: 'desk-knowledge', order: 40, label: '技能与知识', component: KnowledgeSection },
    { id: 'desk-image', order: 42, label: '生图', component: ImageGenSection },
    { id: 'desk-mixed', order: 43, label: 'Mixed 混合', component: MixedSection },
    { id: 'desk-desktop', order: 45, label: '桌面', component: DesktopSection },
  ]
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        sections.map((s) => ctx.slots.register({ name: 'settings.section', id: s.id, order: s.order, label: s.label }, s.component)),
      ),
    'desk-ui: settings sections',
  )

  // ---- 首页大字标：空会话页中央用 THE DIVA 字标取代官方「探索未至之境 · 预览版」（与视频一致）----
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroWordmark)),
    'desk-ui: hero wordmark',
  )

  // ---- 输入框工具行：「文件」芯片（本机文件 → 会话工作目录 _attachments/ → @ 引用）----
  const FileChip = makeFileChip(ctx)
  const ImageChip = makeImageChip(ctx)
  const MixedChip = makeMixedChip()
  const MixedRunPanel = makeMixedRunPanel()
  ctx.effect(
    () => ctx.slots.inject('conversation.input.left', () => [
      ctx.slots.register({ name: 'conversation.input.left', id: 'desk-files', order: 10, label: '文件' }, FileChip),
      ctx.slots.register({ name: 'conversation.input.left', id: 'desk-image', order: 11, label: '生图' }, ImageChip),
      ctx.slots.register({ name: 'conversation.input.left', id: 'desk-mixed', order: 12, label: 'Mixed' }, MixedChip),
    ]),
    'desk-ui: composer file and image chips',
  )
  // ---- Mixed 运行面板（输入框上方 dock：阶段/任务/模型/审核/证据/停止恢复）----
  ctx.effect(
    () => ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({ name: 'conversation.input.dock', id: 'desk-mixed-run', order: 10 }, MixedRunPanel),
    ),
    'desk-ui: mixed run panel',
  )

  // ---- 登录态 / 任务轮询 + Mixed 轮询（活动 1s / 空闲 5s / 隐藏停 / 聚焦同步 / 退避 15s） ----
  ctx.effect(() => {
    const stop = startPolling()
    const stopMixed = startMixedPolling()
    const unsub = deskStore.subscribe(() => {
      const s = deskStore.get()
      // 花名册加载失败会静默返回：等 retry 窗口到期后把 _peopleRequested 复位，让下一轮轮询重试（否则要登出才能恢复）
      if (s.desk?.loggedIn && s.people.length === 0 && s._peopleRequested && Date.now() >= (s._peopleRetryAt ?? 0)) {
        deskStore.set({ _peopleRequested: false })
      }
      if (s.desk?.loggedIn && s.people.length === 0 && !s._peopleRequested) {
        deskStore.set({ _peopleRequested: true, _peopleRetryAt: Date.now() + 20_000 })
        loadPeople()
      }
      if (!s.desk?.loggedIn && s._peopleRequested) deskStore.set({ _peopleRequested: false, people: [] })
    })
    return () => {
      stop()
      stopMixed()
      unsub()
    }
  }, 'desk-ui: polling')
}
