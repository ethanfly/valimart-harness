/**
 * 启动横幅的字符画（Qwen Code 的 ui.customAsciiArt）：惠利玛花标，宽终端再加 VALIMART 字标。
 * 花标与 pi 包 extensions/header.ts 同一张 16×16 轮廓，上下两像素合成一个半格字符。
 * 只输出纯字符，配色交给 Qwen Code 的主题。
 */

const FLOWER_MASK = [
  '.....##...#.....',
  '.....##...##....',
  '..##.##..###.##.',
  '..#####..######.',
  '...####..#####..',
  '.....##..###....',
  '................',
  '.####.......###.',
  '######....######',
  '..####.....####.',
  '..####.##..###..',
  '..###..###..###.',
  '..#...#####..#..',
  '......#####.....',
  '......##.##.....',
  '......#.........',
]

/** 5 行像素字，# 为实心。 */
const GLYPHS = {
  V: ['#...#', '#...#', '#...#', '.#.#.', '..#..'],
  A: ['.###.', '#...#', '#####', '#...#', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#####'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  R: ['####.', '#...#', '####.', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
}

function halfBlocks(mask) {
  const lines = []
  for (let y = 0; y < mask.length; y += 2) {
    let line = ''
    for (let x = 0; x < mask[y].length; x++) {
      const top = mask[y][x] === '#'
      const bot = mask[y + 1]?.[x] === '#'
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines
}

function wordmark(word) {
  const rows = ['', '', '', '', '']
  for (const ch of word) {
    const g = GLYPHS[ch]
    for (let r = 0; r < 5; r++) rows[r] += `${g[r].replace(/#/g, '█').replace(/\./g, ' ')} `
  }
  return rows.map((r) => r.replace(/\s+$/, ''))
}

export function flowerArt() {
  return halfBlocks(FLOWER_MASK).join('\n')
}

/** 花标在左，字标垂直居中在右。 */
export function wideArt() {
  const flower = halfBlocks(FLOWER_MASK)
  const word = wordmark('VALIMART')
  const width = Math.max(...flower.map((l) => l.length))
  const top = Math.floor((flower.length - word.length) / 2)
  return flower
    .map((line, i) => {
      const right = word[i - top]
      return right ? `${line.padEnd(width)}   ${right}` : line
    })
    .join('\n')
}

export function customAsciiArt() {
  return { small: flowerArt(), large: wideArt() }
}
