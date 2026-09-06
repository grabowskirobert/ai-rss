const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};

function ts() {
  return `${C.dim}${new Date().toISOString().slice(11, 19)}${C.reset}`;
}

export const log = {
  phase: (msg)   => console.log(`\n${ts()} ${C.bold}${C.blue}▶ ${msg}${C.reset}`),
  info:  (msg)   => console.log(`${ts()} ${C.cyan}  ${msg}${C.reset}`),
  ok:    (msg)   => console.log(`${ts()} ${C.green}  ✓ ${msg}${C.reset}`),
  skip:  (msg)   => console.log(`${ts()} ${C.gray}  ⊘ ${msg}${C.reset}`),
  warn:  (msg)   => console.warn(`${ts()} ${C.yellow}  ⚠ ${msg}${C.reset}`),
  error: (msg)   => console.error(`${ts()} ${C.red}  ✗ ${msg}${C.reset}`),
  done:  (msg)   => console.log(`\n${ts()} ${C.bold}${C.green}✔ ${msg}${C.reset}\n`),
};
