import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";

export const PRODUCT_NAME = "VALIMART PI DESK";
export const PRODUCT_NAME_ZH = "惠利玛工作交付平台";

const here = path.dirname(fileURLToPath(import.meta.url));
const GRID = JSON.parse(fs.readFileSync(path.join(here, "..", "assets", "mark-grid.json"), "utf8")) as {
  w: number;
  h: number;
  rgba: string;
};
const DESK_VERSION = (JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version: string }).version;

const ANSI = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string) {
  return s.replace(ANSI, "");
}

/** ASCII → 全角，终端里大约宽一倍、字形更大。 */
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

function cell(pix: Buffer, w: number, x: number, y: number) {
  const i = (y * w + x) * 4;
  return [pix[i], pix[i + 1], pix[i + 2], pix[i + 3]] as const;
}

function renderMark() {
  const { w, h, rgba } = GRID;
  const pix = Buffer.from(rgba, "base64");
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const top = cell(pix, w, x, y);
      const bot = y + 1 < h ? cell(pix, w, x, y + 1) : ([0, 0, 0, 0] as const);
      if (top[3] < 24 && bot[3] < 24) {
        line += " ";
        continue;
      }
      if (bot[3] < 24) {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m▀\x1b[0m`;
      } else if (top[3] < 24) {
        line += `\x1b[38;2;${bot[0]};${bot[1]};${bot[2]}m▄\x1b[0m`;
      } else {
        line += `\x1b[38;2;${bot[0]};${bot[1]};${bot[2]}m\x1b[48;2;${top[0]};${top[1]};${top[2]}m▄\x1b[0m`;
      }
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

/** 花标在左，标题 / 版本在右，文字垂直居中。 */
function composeHeader(mark: string[], text: string[], gap = 2) {
  const logoW = Math.max(GRID.w, ...mark.map((l) => stripAnsi(l).length));
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
      const mark = renderMark();
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
