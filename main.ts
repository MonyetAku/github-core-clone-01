// main.ts — the entrypoint that wires this forge up to the trial environment.
//
// The environment (env) is the other side of the trial: it decides where the
// suite should reach this forge, pushes traffic at it, and eventually declares
// the trial finished. This file is the only part of the entry that speaks to
// the env at all; the forge itself lives in app.ts. The exchange runs in
// this order:
//
//   1. Look up the env's address in MAKEFUN_ENV_URL. With no address there
//      is no trial to join, so say so on stderr and exit 1.
//   2. Start the forge on a port the kernel picks (listen on 0). Never ask
//      for 8080: that port belongs to the env.
//   3. Announce the chosen port with POST /register. Keep announcing until
//      the env accepts it (200) or tells us another entry already claimed
//      the slot (409 — a lost race, not an error). A 400 or 405 means the
//      request itself is wrong for this env, so give up instead of looping.
//   4. Ask GET /done over and over until it answers {"done": true}. A
//      refused connection, a timeout, or a "not yet" body all mean the same
//      thing: keep asking.
//   5. Stop the forge and exit 0. The harness then stops the env, and the
//      scorer reads the export the env wrote.
//
// Timing here is only the retry backoff below. Nothing in this file reads
// the wall clock or rolls dice, and no request handling happens here at all.

import { createApp } from './app.ts';

// --- talking to the env ------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set, so there is no trial environment to join\n');
  process.exit(1);
}

/** A single env request may run this long before it counts as failed. */
const REQUEST_BUDGET_MS = 30_000;
/** Pause before the second attempt after a failure. */
const FIRST_BACKOFF_MS = 250;
/** Pause never grows past this, however many attempts fail in a row. */
const LONGEST_BACKOFF_MS = 2_000;

/** Wait `ms` milliseconds before doing something again. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pause to take after `failures` consecutive failures: it doubles from
 * FIRST_BACKOFF_MS each time and stops growing at LONGEST_BACKOFF_MS.
 */
function backoffFor(failures: number): number {
  let pause = FIRST_BACKOFF_MS;
  for (let i = 0; i < failures; i += 1) {
    if (pause >= LONGEST_BACKOFF_MS) break;
    pause *= 2;
  }
  return Math.min(pause, LONGEST_BACKOFF_MS);
}

/** What one attempt at a step reports back to the retry loop. */
type AttemptResult = 'finished' | 'try-again';

/** Thrown when the env answers in a way that means our request is wrong. */
class RejectedByEnv extends Error {}

/**
 * Call `attempt` until it reports 'finished'. Anything it throws is treated
 * as a passing failure and retried, except a RejectedByEnv, which ends the
 * process: the request itself is at fault and retrying cannot help.
 */
async function repeatUntilDone(attempt: () => Promise<AttemptResult>): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      if ((await attempt()) === 'finished') return;
    } catch (error) {
      if (error instanceof RejectedByEnv) throw error;
    }
    failures += 1;
    await wait(backoffFor(failures));
  }
}

/**
 * POST the port this forge listens on until the env takes it. 200 means
 * accepted, 409 that another entry registered first (we still proceed: the
 * env dials whichever entry won). 400/405 are fatal; anything else, and any
 * transport failure, is retried on the assumption the env is still coming up.
 */
async function announcePort(port: number): Promise<void> {
  await repeatUntilDone(async () => {
    const response = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (response.status === 200 || response.status === 409) return 'finished';
    if (response.status === 400 || response.status === 405) {
      throw new RejectedByEnv(`register was refused with HTTP ${response.status}: ${await response.text()}`);
    }
    return 'try-again';
  });
}

/** Ask GET /done until the env answers {"done": true}. */
async function awaitDone(): Promise<void> {
  await repeatUntilDone(async () => {
    const response = await fetch(`${ENV_URL}/done`, {
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (!response.ok) return 'try-again';
    const payload = (await response.json()) as { done?: unknown };
    return payload.done === true ? 'finished' : 'try-again';
  });
}

// --- the forge's life --------------------------------------------------------

/** Start the forge and hand back the port the kernel gave it. */
async function startForge(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  return { server, port: bound.port };
}

/** The whole run: start, announce, wait for the env to finish, shut down. */
async function run(): Promise<void> {
  const { server, port } = await startForge();
  process.stdout.write(`forge listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('registered with the trial environment; waiting for done\n');

  await awaitDone();
  server.close();
  process.stdout.write('trial done, forge stopped\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`entry failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
