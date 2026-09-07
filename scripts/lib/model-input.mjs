/**
 * 模型输入模态：聊天模型默认可看图；生图 / 视频模型只收文本。
 * 内核 llm-pi-ai 用 input: ['text','image'] 决定会不会弹出「当前模型不支持图片」。
 */
const GEN_ONLY = /imagine-image|imagine-video|dall-e|gpt-image|flux|qwen-image|image-generation|video-generation|text-to-video/i

export function inferModelInput(id) {
  const s = String(id ?? '')
  if (!s || GEN_ONLY.test(s) || /^mock[-_]?/i.test(s)) return ['text']
  return ['text', 'image']
}

export function resolveModelInput(model = {}) {
  if (Array.isArray(model.input) && model.input.length) {
    const set = new Set(model.input.filter((x) => x === 'text' || x === 'image'))
    set.add('text')
    return set.has('image') ? ['text', 'image'] : ['text']
  }
  if (model.vision === false) return ['text']
  if (model.vision === true) return ['text', 'image']
  return inferModelInput(model.id)
}
