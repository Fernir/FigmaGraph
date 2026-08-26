/** Minimal terminal UI — codegraph-like colors, no extra deps. */

const isTTY = process.stdout.isTTY === true;
const enabled =
  isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

const wrap =
  (open: string, close = "\x1b[0m") =>
  (s: string) =>
    enabled ? `${open}${s}${close}` : s;

export const bold = wrap("\x1b[1m");
export const dim = wrap("\x1b[2m");
export const cyan = wrap("\x1b[36m");
export const blue = wrap("\x1b[34m");
export const green = wrap("\x1b[32m");
export const yellow = wrap("\x1b[33m");
export const red = wrap("\x1b[31m");
export const magenta = wrap("\x1b[35m");

export function title(text: string): void {
  console.log();
  console.log(bold(text));
  console.log();
}

export function success(msg: string): void {
  console.log(`${green("✓")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${blue("ℹ")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${yellow("⚠")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${red("✗")} ${msg}`);
}

/** Aligned key/value line: `  Files:     526` */
export function kv(key: string, value: string, keyWidth = 12): void {
  const label = cyan(key.padEnd(keyWidth));
  console.log(`  ${label}${value}`);
}

export function section(text: string): void {
  console.log();
  console.log(bold(text));
}

export function blank(): void {
  console.log();
}

/** Box header like clack / codegraph install. */
export function banner(name: string, version: string, subtitle?: string): void {
  console.log(`${dim("┌")}  ${bold(name)} ${dim(`v${version}`)}`);
  if (subtitle) {
    console.log(`${dim("│")}`);
    console.log(`${dim("│")}  ${dim(subtitle)}`);
  }
  console.log(`${dim("│")}`);
}

export function bannerLine(text: string): void {
  console.log(`${dim("│")}  ${text}`);
}

export function bannerCmd(cmd: string, desc: string, width = 14): void {
  console.log(`${dim("│")}    ${cyan(cmd.padEnd(width))}${dim(desc)}`);
}

export function bannerEnd(): void {
  console.log(`${dim("└")}`);
  console.log();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
