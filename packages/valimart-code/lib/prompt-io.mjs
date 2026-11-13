/**
 * 启动前的终端问答（valimart login）：选网关、填账号、不回显地读密码。
 * 只在 stdin/stdout 都是终端时用；问完把 stdin 交还（暂停、退出原始模式），之后 Qwen Code 的界面接管终端。
 */
import readline from 'node:readline'

export class PromptCancelled extends Error {
  constructor() {
    super('已取消')
  }
}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const say = (text) => output.write(`${text}\n`)

  function ask(question, { defaultValue = '' } = {}) {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) })
    return new Promise((resolve, reject) => {
      let answered = false
      rl.on('SIGINT', () => {
        output.write('\n')
        rl.close()
      })
      rl.on('close', () => {
        if (!answered) reject(new PromptCancelled())
      })
      rl.question(`${question}${defaultValue ? `（回车 = ${defaultValue}）` : ''}：`, (answer) => {
        answered = true
        rl.close()
        resolve(answer.trim() || defaultValue)
      })
    })
  }

  /** 不回显：原始模式逐字读，退格可删，Ctrl+C / Ctrl+D 取消。粘贴进来的一整段也按字处理。 */
  function askHidden(question) {
    if (!input.isTTY || typeof input.setRawMode !== 'function') return ask(question)
    output.write(`${question}：`)
    return new Promise((resolve, reject) => {
      let value = ''
      const finish = (fn) => {
        input.off('data', onData)
        input.setRawMode(false)
        input.pause()
        output.write('\n')
        fn()
      }
      const onData = (chunk) => {
        for (const ch of String(chunk)) {
          if (ch === '\r' || ch === '\n') return finish(() => resolve(value))
          if (ch === '\u0003' || ch === '\u0004') return finish(() => reject(new PromptCancelled()))
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
          else if (ch >= ' ') value += ch
        }
      }
      input.setRawMode(true)
      input.setEncoding('utf8')
      input.on('data', onData)
      input.resume()
    })
  }

  /** 编号列表选一项，返回下标。 */
  async function choose(title, labels) {
    say(title)
    labels.forEach((label, i) => say(`  ${i + 1}) ${label}`))
    for (;;) {
      const raw = await ask('输入序号', { defaultValue: '1' })
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1
      say(`请输入 1-${labels.length} 之间的序号`)
    }
  }

  return { say, ask, askHidden, choose }
}
