#!/usr/bin/env node
/**
 * Polls the gateway's aggregate health and prints a combined status.
 *
 * The backlog asks for "a basic dashboard or script that polls all services'
 * /health and prints a combined status". A script rather than a web dashboard:
 * the thing being demonstrated is that the system reports its own state, and a
 * terminal that redraws every two seconds shows a service dying and recovering
 * far more directly than a page someone has to refresh.
 *
 *   node scripts/health-dashboard.mjs            # watch, refreshing
 *   node scripts/health-dashboard.mjs --once     # one snapshot, exit code 0/1
 *
 * `--once` exits non-zero when anything is degraded, so it works as a smoke
 * check in a script or a deploy gate.
 */

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);
const once = process.argv.includes('--once');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function mark(status) {
  if (status === 'ok' || status === 'up') return `${GREEN}●${RESET}`;
  if (status === 'unreachable' || status === 'down') return `${RED}●${RESET}`;
  return `${YELLOW}●${RESET}`;
}

function circuitLabel(circuit) {
  if (!circuit || circuit === 'unused') return '';
  if (circuit === 'closed') return `${DIM}circuit closed${RESET}`;
  if (circuit === 'open') return `${RED}CIRCUIT OPEN${RESET}`;
  return `${YELLOW}circuit half-open${RESET}`;
}

async function fetchHealth() {
  const response = await fetch(`${GATEWAY}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.json();
}

function render(health) {
  const lines = [];
  lines.push(
    `${mark(health.status)} forge — ${health.status.toUpperCase()}` +
      `   ${DIM}${new Date(health.checkedAt).toLocaleTimeString()}${RESET}`,
  );
  lines.push('');

  for (const [name, report] of Object.entries(health.services)) {
    const circuit = circuitLabel(report.circuit);
    lines.push(
      `  ${mark(report.status)} ${name.padEnd(20)} ${String(report.status).padEnd(12)} ${circuit}`,
    );

    if (report.status === 'unreachable') {
      lines.push(`      ${DIM}${report.message}${RESET}`);
      continue;
    }

    for (const [dependency, indicator] of Object.entries(
      report.details ?? {},
    )) {
      const detail =
        indicator.status === 'down' ? ` ${DIM}${indicator.message}${RESET}` : '';
      lines.push(
        `      ${mark(indicator.status)} ${dependency.padEnd(16)}${detail}`,
      );
    }
  }

  return lines.join('\n');
}

async function tick() {
  try {
    const health = await fetchHealth();
    return { output: render(health), healthy: health.status === 'ok' };
  } catch (error) {
    // The gateway itself being unreachable is the one case the aggregate
    // endpoint cannot report, so it is handled here.
    return {
      output: `${mark('unreachable')} gateway unreachable at ${GATEWAY}\n      ${DIM}${error.message}${RESET}`,
      healthy: false,
    };
  }
}

if (once) {
  const { output, healthy } = await tick();
  console.log(output);
  process.exit(healthy ? 0 : 1);
}

console.log(`Polling ${GATEWAY}/health every ${INTERVAL_MS}ms — Ctrl-C to stop\n`);

for (;;) {
  const { output } = await tick();
  // Clear and redraw in place, so a service dying is visible as a change
  // rather than as more scrollback.
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(output);
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
