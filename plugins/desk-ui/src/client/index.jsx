/**
 * @company-desk/desk-ui · 浏览器端插件入口。
 * 取代 ui-layout / ui-sidebar / ui-brand-official：THE DIVA 外壳、会话/任务侧栏、任务卡面板、公司设置页、登录遮罩。
 */
import css from './styles.css'
import { DeskFrame, DeskLayoutController, ThemePresenter } from './layout.jsx'
import { DeskSidebar } from './sidebar.jsx'
import { AccountSection, ColleaguesSection, KnowledgeSection, PersonnelSection, QuickInferenceSection, SubscriptionSection } from './settings.jsx'
import { startPolling, loadPeople } from './api.js'
import { deskStore } from './store.js'
import { makeFileChip } from './composer.jsx'
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
  // ---- 样式 ----
  ctx.effect(() => {
    const el = document.createElement('style')
    el.setAttribute('data-plugin', '@company-desk/desk-ui')
    el.textContent = css
    document.head.append(el)
    return () => el.remove()
  }, 'desk-ui: styles')

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
            startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId),
            toggleSidebar: () => layout.toggleSidebar(),
          }),
        },
        DeskSidebar,
      ),
    'desk-ui: sidebar registration',
  )

  // ---- 设置页：账号 / 同事 / 人员 / 快速推理 / 订阅 ----
  const sections = [
    { id: 'desk-account', order: 2, label: '账号', component: AccountSection },
    { id: 'desk-colleagues', order: 5, label: '同事', component: ColleaguesSection },
    { id: 'desk-personnel', order: 25, label: '人员', component: PersonnelSection },
    { id: 'desk-quick', order: 30, label: '快速推理', component: QuickInferenceSection },
    { id: 'desk-subscription', order: 35, label: '订阅', component: SubscriptionSection },
    { id: 'desk-knowledge', order: 40, label: '技能与知识', component: KnowledgeSection },
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
  ctx.effect(
    () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'desk-files', order: 10, label: '文件' }, FileChip)),
    'desk-ui: composer file chip',
  )

  // ---- 登录态 / 任务轮询 ----
  ctx.effect(() => {
    const stop = startPolling()
    const unsub = deskStore.subscribe(() => {
      const s = deskStore.get()
      if (s.desk?.loggedIn && s.people.length === 0 && !s._peopleRequested) {
        deskStore.set({ _peopleRequested: true })
        loadPeople()
      }
      if (!s.desk?.loggedIn && s._peopleRequested) deskStore.set({ _peopleRequested: false, people: [] })
    })
    return () => {
      stop()
      unsub()
    }
  }, 'desk-ui: polling')
}
