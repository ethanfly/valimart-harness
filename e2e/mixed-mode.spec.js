/**
 * Mixed 混合模式 · 真实内核页面完整流程 e2e（T08 验收：不以手写 HTML 代替）。
 *
 * 前置（真实内核三件套：内核 + 仓库网关 + dev 客户端）：
 *   1) 仓库网关（带 /api/mixed/catalog，生产 8790 旧版网关没有）：
 *      $env:DESK_GATEWAY_PORT='8795'; $env:DESK_GATEWAY_DATA='<临时目录>'
 *      node server/src/index.js
 *   2) 隔离 dev 客户端（独立 dsh-home，避免动生产 ~/.dsh/desk 登录态）：
 *      node scripts/launch.mjs --port 3472 --no-open --dsh-home 'C:\Users\ethan\.dsh-mixed-e2e'
 *   3) 环境变量 + 跑：
 *      $env:DESK_MIXED_URL   = 'http://127.0.0.1:3472/?token=<launch 输出>'
 *      $env:MIXED_E2E_GATEWAY = 'http://127.0.0.1:8795'   （未登录时走真实登录遮罩）
 *      $env:MIXED_E2E_USER / $env:MIXED_E2E_PASSWORD       （默认 boss / boss123456，仓库网关 seedAdmin）
 *      npx playwright test e2e/mixed-mode.spec.js
 *
 * 覆盖（计划 T08 ①–⑤）：
 *  0. 页面就绪：已登录快速路径（首次运行走真实登录遮罩：网关地址 + 账号密码，见 00-logged-in 证据）；
 *  1. 新会话 + 输入工具行出现 Mixed 芯片（客户端 bundle + slot 注入）+ 会话作用域 sessionId；
 *  2. 设置：Mixed 分节、三模型选择器（真实目录）、保存持久化 + 「下一次运行生效」；
 *  3a. 芯片启用：宿主 attach + 模式落盘（刚保存配置后立即启用：配置实时校验，不等 5s 轮询）；
 *  3b. Plan 互斥：注入官方 PlanChip 形态的 DOM → 拒绝启用；移除后互斥解除可启用；
 *  4. 完整运行：新会话输入目标 → Enter 发送 → 桥拦截 → run 创建 → 面板阶段/目标/模型 →
 *     停止（意图落盘 → cancelled）→ 终态横幅。
 *
 * 环境注意（2026-09-09 实测定性）：
 *  - 本应用「新会话」按钮 = 选中持久空会话，不逐次创建新会话（两次点击无新行/无新 sid）；
 *    会话 id 从芯片 fiber props 读取（= watch 轮询目标会话，实测一致）。各测试隔离靠
 *    resetMixed（回到 mixed=off）+ 从已知 off 态起步，不靠新会话。
 *  - 曾怀疑「浏览器 ~30s 被掐断」，实为复现脚本自身 browser.close()/worker 浏览器复用所致；
 *    每测试独立 browser（本文件）后连续多轮无意外丢失。
 *  - run 终态收敛/排队输入/刷新不丢等宿主侧行为由 scripts/test/mixed-*.test.mjs（92 例）
 *    与 probe 18/18 覆盖，不依赖 e2e 长窗口。
 */
import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const url = process.env.DESK_MIXED_URL
const gwUrl = process.env.MIXED_E2E_GATEWAY || ''
const user = process.env.MIXED_E2E_USER || 'boss'
const password = process.env.MIXED_E2E_PASSWORD || 'boss123456'
const shotDir = path.resolve('e2e', 'artifacts', 'mixed')

test.describe('Mixed 混合模式 · 真实内核页', () => {
  test.describe.configure({ timeout: 120_000 })
  // 未设 DESK_MIXED_URL 时整套跳过（静态注解，不注册失败）
  test.skip(!url, '设 DESK_MIXED_URL=dev 实例 URL（带 token）才打真内核页')

  let browser
  let page

  const instrument = (p) => {
    p.on('crash', () => console.log('[e2e] !!! 页面渲染进程崩溃（crash）'))
    p.on('close', () => console.log(`[e2e] !!! 页面被关闭（close）url=${p.url()}`))
    p.on('pageerror', (e) => console.log('[e2e] pageerror:', e.message))
    p.on('console', (m) => {
      if (m.type() === 'error') console.log('[e2e] console.error:', m.text().substring(0, 200))
    })
  }

  test.beforeEach(async () => {
    // 每测试独立浏览器：隔离环境传输掐断的窗口，单测自洽
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    })
    browser.on('disconnected', () => console.log('[e2e] !!! 浏览器传输断开（disconnected，见文件头环境注意）'))
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
    instrument(page)
    await page.exposeFunction('__e2eBeat', () => {}) // 预留（心跳在需要时启用）
    // 就绪：已登录 → 芯片直接出现；未登录 → 真实登录遮罩流程
    await page.goto(url)
    const chip = page.locator('button.dk-mixed-chip')
    const userField = page.locator('input[autocomplete="username"]')
    const who = await Promise.race([
      chip.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'app').catch(() => null),
      userField.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'overlay').catch(() => null),
    ])
    if (who === 'overlay') {
      if (gwUrl) await page.locator('.dk-gateway-row input').first().fill(gwUrl)
      await userField.fill(user)
      await page.locator('input[autocomplete="current-password"]').fill(password)
      await page.locator('button.dk-btn.primary', { hasText: '登录' }).click()
      // 全新 DSH_HOME 登录后还没有会话；芯片挂在输入工具行，要先落到一个会话
      const newSess = page.locator('button.dk-iconbtn[title="新会话"]').first()
      const appeared = await Promise.race([
        chip.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'chip'),
        newSess.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'new'),
      ]).catch(() => null)
      if (appeared === 'new' && !(await chip.isVisible().catch(() => false))) {
        await newSess.click()
      }
      await expect(chip).toBeVisible({ timeout: 30_000 })
    }
    expect(who, '页面未就绪：既无 Mixed 芯片也无登录遮罩').toBeTruthy()
  })
  test.afterEach(async () => {
    await browser?.close().catch(() => {})
    browser = null
    page = null
  })

  const api = (p, path) => p.evaluate(async (pp) => {
    const r = await fetch(`/desk/api${pp}`)
    const j = await r.json().catch(() => ({}))
    return { ok: r.ok, status: r.status, body: j }
  }, path)
  const shot = async (name) => {
    fs.mkdirSync(shotDir, { recursive: true })
    const file = path.join(shotDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    await page.screenshot({ path: file })
    return file
  }
  // 读当前会话 id（芯片 fiber props = 当前所在会话；实测与 watch 轮询目标会话一致）。
  // 注：本应用的「新会话」按钮是选中那个持久的空会话（不逐次创建新会话），
  // 因此各测试的隔离靠 resetMixed（回到 mixed=off）保证，而不是靠新会话。
  const currentSessionId = async (p) => {
    const sid = await p.evaluate(() => {
      const el = document.querySelector('button.dk-mixed-chip')
      if (!el) return null
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      if (!fk) return null
      let f = el[fk]
      for (let i = 0; f && i < 25; i++) {
        const pr = f.memoizedProps
        if (pr && typeof pr.sessionId === 'string' && pr.sessionId) return pr.sessionId
        f = f.return
      }
      return null
    })
    expect(sid, '芯片未拿到会话 id（conversation 作用域注入失效）').toMatch(/^session-/)
    return sid
  }
  // 隔离：把会话回到 mixed=off（独立 dsh-home，测试互不串状态）；并等芯片视觉态跟上
  const resetMixed = async (p, sid) => {
    const cur = await api(p, `/sessions/${sid}/mixed`)
    if (cur.body?.mode?.enabled) {
      await p.evaluate(async (s) => {
        await fetch(`/desk/api/sessions/${s}/mixed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        })
      }, sid)
      // store 缓存可能还是「on」（页面装载 tick 早于本 reset），等空闲 tick 纠正
      await expect(p.locator('button.dk-mixed-chip')).not.toHaveClass(/on/, { timeout: 10_000 })
    }
  }
  // 到空的「新会话」并读回会话 id
  const newSession = async (p) => {
    await p.locator('button.dk-iconbtn[title="新会话"]').first().click()
    await expect(p.locator('button.dk-mixed-chip')).toBeVisible({ timeout: 30_000 })
    return currentSessionId(p)
  }

  test('0 页面就绪：登录态保留 → Mixed 芯片在输入工具行', async () => {
    await expect(page.locator('button.dk-mixed-chip')).toBeVisible()
    await shot('00-ready')
  })

  test('1 新会话：芯片随会话作用域出现（slot 注入 + sessionId）', async () => {
    const sid = await newSession(page)
    expect(typeof sid).toBe('string')
    expect(sid.length, '会话 id 形态异常').toBeGreaterThan(10)
    await shot('01-chip')
  })

  test('2 设置：Mixed 分节 + 三模型选择 + 保存持久化', async () => {
    await page.locator('span[title="打开设置"]').first().click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.locator('nav button', { hasText: 'Mixed 混合' }).click()

    const cfg = await api(page, '/mixed/config')
    expect(cfg.ok, `GET /mixed/config 失败: ${JSON.stringify(cfg.body)}`).toBe(true)
    const models = cfg.body?.catalog?.models ?? []
    expect(models.length, '公司目录无模型').toBeGreaterThan(0)

    // 三个角色选择器都有真实目录选项；启发式不再把短上下文模型灰掉
    const companyIds = models.map((m) => m.id ?? m.modelId).filter(Boolean)
    expect(companyIds.length, '公司目录无模型 id').toBeGreaterThan(0)
    for (const role of ['规划器', '执行器', '审核器']) {
      const block = dialog.locator(`.dk-mixed-role`, { hasText: role }).first()
      await expect(block).toBeVisible()
      const select = block.locator('select.dk-select')
      const enabledVals = await select.locator('option:not([disabled])').evaluateAll(
        (opts) => opts.map((o) => o.value).filter(Boolean),
      )
      expect(enabledVals.length, `${role} 没有可选模型`).toBeGreaterThan(0)
      for (const id of companyIds) {
        const hit = enabledVals.some((v) => v === id || v.endsWith(`|${id}`))
        expect(hit, `${role} 未列出公司模型 ${id}`).toBe(true)
      }
    }
    await shot('02-settings-selects')

    // 各选一个模型并保存；已保存过的重跑场景：首选项可能==现值（不脏）→ 强制换一个，保证保存按钮变可用
    for (const role of ['规划器', '执行器', '审核器']) {
      const select = dialog.locator('.dk-mixed-role', { hasText: role }).first().locator('select.dk-select')
      const enabledVals = await select.locator('option:not([disabled])').evaluateAll(
        (opts) => opts.map((o) => o.value).filter(Boolean),
      )
      expect(enabledVals.length, `${role} 没有可选模型`).toBeGreaterThanOrEqual(1)
      const current = await select.inputValue()
      const target = enabledVals.find((v) => v !== current) ?? enabledVals[0]
      await select.selectOption({ value: target })
    }
    const save = dialog.locator('button.dk-btn', { hasText: '保存' }).first()
    await expect(save).toBeEnabled({ timeout: 5_000 })
    await save.click()
    // 成功：按钮变「已保存」，且出现「下一次运行生效」提示
    await expect(dialog.locator('button.dk-btn:has-text("已保存")').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.dk-toast', { hasText: '下一次运行生效' }).first()).toBeVisible({ timeout: 10_000 })

    // 持久化：再查一次 config，三个角色都有快照
    const cfg2 = await api(page, '/mixed/config')
    for (const role of ['planner', 'executor', 'reviewer']) {
      expect(cfg2.body?.preferences?.[role]?.modelId, `${role} 未持久化`).toBeTruthy()
    }
    await shot('03-settings-saved')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5_000 })
  })

  test('3a 芯片启用：刚保存配置后立即启用（attach + 模式落盘）', async () => {
    const sid = await newSession(page)
    await resetMixed(page, sid) // 隔离：从已知 off 态开始
    const chip = page.locator('button.dk-mixed-chip')
    await chip.click()
    // 宿主先落盘（POST 同步 attach）；芯片 on 态随后 store tick（≤5s）
    await expect
      .poll(async () => (await api(page, `/sessions/${sid}/mixed`)).body?.mode?.enabled, { timeout: 10_000 })
      .toBe(true)
    await expect(chip).toHaveClass(/on/, { timeout: 10_000 })
    const mode = await api(page, `/sessions/${sid}/mixed`)
    expect(mode.ok).toBe(true)
    expect(mode.body?.mode?.enabled, '模式未启用').toBe(true)
    // GET 语义：{mode, activeRun, canToggle, configured}（attached 在 POST 响应；attach 接线由测试 4 的桥拦截证明）
    expect(mode.body?.configured, '配置应已生效（三模型已保存）').toBe(true)
    expect(mode.body?.canToggle, '无活动 run 时可切换').toBe(true)
    await shot('04-chip-enabled')
  })

  test('3b Plan 互斥：官方 PlanChip 形态存在时拒绝启用，移除后解除', async () => {
    const sid = await newSession(page)
    await resetMixed(page, sid) // 隔离：从已知 off 态开始
    // 注入官方 Plan 芯片的稳定选择器形态（plan mode 激活时官方只渲染该 chip）
    await page.evaluate(() => {
      const b = document.createElement('button')
      b.className = 'rS3zOq_chip'
      b.title = 'plan mode 已开启 — 点击关闭（/plan off）'
      b.setAttribute('aria-label', 'plan mode 已开启，按下关闭')
      b.id = 'e2e-plan-chip'
      document.body.appendChild(b)
    })
    // 等 MutationObserver 回调 + React 状态落定（planActive=true），再点击
    await page.waitForTimeout(400)
    const chip = page.locator('button.dk-mixed-chip')
    await chip.click()
    // 拒绝：DOM 判定即时生效 → 互斥 toast；宿主侧从未收到启用
    await expect(page.locator('.dk-toast', { hasText: '互斥' }).first()).toBeVisible({ timeout: 5_000 })
    await expect(chip).not.toHaveClass(/on/, { timeout: 3_000 })
    const mode = await api(page, `/sessions/${sid}/mixed`)
    expect(mode.body?.mode?.enabled, 'Plan 激活时不得启用 Mixed').toBeFalsy()
    await shot('05-plan-mutex')
    // 移除 Plan 芯片 → 互斥解除，可正常启用
    await page.evaluate(() => document.getElementById('e2e-plan-chip')?.remove())
    await page.waitForTimeout(400)
    await chip.click()
    await expect
      .poll(async () => (await api(page, `/sessions/${sid}/mixed`)).body?.mode?.enabled, { timeout: 10_000 })
      .toBe(true)
    await expect(chip).toHaveClass(/on/, { timeout: 10_000 })
  })

  test('4 完整运行：发送 → 桥拦截 → 面板（阶段/目标/模型）→ 停止 → cancelled + 终态横幅', async () => {
    const sid = await newSession(page)
    await resetMixed(page, sid) // 隔离：从已知 off 态开始
    // 启用：宿主落盘即确认（POST 内同步 attach 桥）；发送前必须等落盘，否则桥未装、消息会走普通路径
    await page.locator('button.dk-mixed-chip').click()
    await expect
      .poll(async () => (await api(page, `/sessions/${sid}/mixed`)).body?.mode?.enabled, { timeout: 10_000 })
      .toBe(true)
    await expect(page.locator('button.dk-mixed-chip')).toHaveClass(/on/, { timeout: 10_000 })
    await page.waitForTimeout(500) // 桥安装缓冲

    // Enter 发送（Lexical composer 根节点）
    const editor = page.locator('[data-lexical-editor="true"]').last()
    await editor.click()
    await page.keyboard.type('e2e-mixed：在本会话工作目录建一个 hello-mixed.txt，写入一行 hello，并说明该文件路径。', { delay: 10 })
    await page.keyboard.press('Enter')

    // 桥拦截后 run 必须出现（claim 先于 LLM 调用，1s 轮询内可见）
    await expect
      .poll(async () => (await api(page, `/mixed/runs?sessionId=${sid}`)).body?.items?.length ?? 0, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1)

    // 面板出现（活动态）：目标 + 状态
    const panel = page.locator('.dk-mixed-panel.active')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.locator('.dk-mixed-goal')).toContainText('e2e-mixed', { timeout: 10_000 })
    // 模型快照行（实际模型来自角色路由，创建时固定）
    await expect(panel.locator('.dk-mixed-models')).toBeVisible({ timeout: 15_000 })
    await shot('06-run-panel')

    // 停止（受理 ≠ 停止：等收敛到 cancelled）
    await panel.locator('button', { hasText: '停止' }).click()
    await expect
      .poll(async () => (await api(page, `/mixed/runs?sessionId=${sid}`)).body?.items?.[0]?.status, { timeout: 60_000 })
      .toBe('cancelled')

    // 终态横幅（已停止）
    await expect(page.locator('.dk-mixed-panel.terminal')).toBeVisible({ timeout: 15_000 })
    await shot('07-cancelled-banner')
  })
})
