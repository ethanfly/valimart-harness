import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";

export const PRODUCT_NAME = "VALIMART PI DESK";
export const PRODUCT_NAME_ZH = "惠利玛工作交付平台";

const here = path.dirname(fileURLToPath(import.meta.url));
const DESK_VERSION = (JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version: string }).version;

/**
 * 原花标是白底透明 PNG，桌面用 mask + currentColor。
 * 下列 16×16 是 PNG 最近邻轮廓（六瓣），上色用主题 accent，和标题同色。
 */
const FLOWER_MASK = [
  ".....##...#.....",
  ".....##...##....",
  "..##.##..###.##.",
  "..#####..######.",
  "...####..#####..",
  ".....##..###....",
  "................",
  ".####.......###.",
  "######....######",
  "..####.....####.",
  "..####.##..###..",
  "..###..###..###.",
  "..#...#####..#..",
  "......#####.....",
  "......##.##.....",
  "......#.........",
];

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string) {
  return s.replace(ANSI, "");
}

function fullwidth(s: string) {
  return [...s]
    .map((ch) => {
      if (ch === " ") return "　";
      const c = ch.charCodeAt(0);
      if (c >= 33 && c <= 126) return String.fromCharCode(c + 0xfee0);
      return ch;
    })
    .join("");
}

function on(row: number, col: number) {
  return FLOWER_MASK[row]?.[col] === "#";
}

function ansiRgb(ansi: string): [number, number, number] | null {
  const m = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isDefaultGold([r, g, b]: [number, number, number]) {
  return r > 160 && g > 120 && b < 130 && r >= g;
}

/** 默认白花标；主题 accent 不是默认金色时跟主题色；浅色主题用正文色。 */
function markInk(theme: Theme, ch: string) {
  const accent = ansiRgb(theme.getFgAnsi("accent"));
  if (accent && !isDefaultGold(accent)) return theme.bold(theme.fg("accent", ch));
  const text = ansiRgb(theme.getFgAnsi("text"));
  if (text && text[0] + text[1] + text[2] < 360) return theme.bold(theme.fg("text", ch));
  return `\x1b[1m\x1b[38;2;255;255;255m${ch}\x1b[0m`;
}

function renderMark(theme: Theme) {
  const h = FLOWER_MASK.length;
  const w = FLOWER_MASK[0].length;
  const ink = (ch: string) => markInk(theme, ch);
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const top = on(y, x);
      const bot = on(y + 1, x);
      if (top && bot) line += ink("█");
      else if (top) line += ink("▀");
      else if (bot) line += ink("▄");
      else line += " ";
    }
    lines.push(line);
  }
  while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();
  while (lines.length && !stripAnsi(lines[lines.length - 1]).trim()) lines.pop();
  return lines;
}

function padVisible(line: string, width: number) {
  const n = stripAnsi(line).length;
  return n >= width ? line : line + " ".repeat(width - n);
}

function composeHeader(mark: string[], text: string[], gap = 3) {
  const logoW = Math.max(1, ...mark.map((l) => stripAnsi(l).length));
  const rows = Math.max(mark.length, text.length);
  const textTop = Math.max(0, Math.floor((mark.length - text.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = padVisible(mark[i] ?? "", logoW);
    const ti = i - textTop;
    const right = ti >= 0 && ti < text.length ? text[ti] : "";
    out.push(right ? `${left}${" ".repeat(gap)}${right}` : left);
  }
  return out;
}

export function createValimartHeader(theme: Theme) {
  return {
    render(_width: number): string[] {
      const mark = renderMark(theme);
      const text = [
        theme.bold(theme.fg("accent", fullwidth(PRODUCT_NAME))),
        theme.fg("muted", PRODUCT_NAME_ZH),
        theme.fg("dim", `v${DESK_VERSION}  ·  pi v${VERSION}`),
      ];
      return ["", ...composeHeader(mark, text), ""];
    },
    invalidate() {},
  };
}
