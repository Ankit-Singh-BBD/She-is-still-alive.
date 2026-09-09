/**
 * The process entry point.
 *
 * This file does the five things that only a process can do — read `.env`, write
 * to the console, bind a port, listen for signals, and set an exit code — and
 * nothing else. All composition lives in `server/app.ts` and
 * `server/http/server.ts`, so a test can boot the real application, and mount the
 * real routes, without inheriting a process.
 *
 * Run it with `npm start`.
 */

import { config as loadDotenv } from 'dotenv';

import { loadConfig, describeConfig, ConfigError } from '@server/config/env.js';
import { createApp, type MadhuritaApp, type BootReport } from '@server/app.js';
import {
  attachVoiceGateway,
  createHttpServer,
  VOICE_PATH,
  type RunningHttpServer,
} from '@server/http/index.js';

// `.env` is read here and nowhere else. Until now `dotenv` was a dependency
// that was never actually called, which meant every value an operator put in
// `.env` was silently ignored.
//
// This runs after the imports rather than before, because in ESM it has to:
// import declarations are hoisted, so no statement can precede them. It is
// safe because `server/config/env.ts` reads `process.env` when `loadConfig()`
// is called, not when the module is evaluated — nothing has looked at the
// environment yet.
loadDotenv();

function printBootReport(report: BootReport): void {
  if (report.auditRowsChained > 0) {
    console.log(`  audit chain      : chained ${report.auditRowsChained} pre-migration rows`);
  }
  // The roster she can actually execute. `BootReport.tools` existed from the
  // start but nothing printed it, so an operator had no way to see what stage 7
  // could reach without reading the source.
  if (report.tools.length > 0) {
    console.log(`  tools            : ${report.tools.length}`);
    for (const id of report.tools) {
      console.log(`                     ${id}`);
    }
  }
  if (report.ownerEnrolled) {
    // The absence of an owner is reported below; its presence was reported
    // nowhere, which made a fresh database and an enrolled one look alike.
    console.log('  owner            : enrolled');
  }
  for (const line of report.started) {
    console.log(`  running          : ${line}`);
  }
  if (report.absent.length > 0) {
    console.log('');
    console.log('  Not available in this configuration:');
    for (const line of report.absent) {
      console.log(`    - ${line}`);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('');
  console.log('  Madhurita');
  console.log('');
  console.log(describeConfig(config));
  console.log('');

  const app: MadhuritaApp = createApp({ config });
  const report = await app.start();
  printBootReport(report);

  // The listener comes up after `start()`, so a request can never arrive at a
  // half-built application: the tool roster is checked, the audit chain is
  // written and the background loops are running before the port is open.
  //
  // A failure here is fatal and must not leave the app running — `start()` has
  // already opened a database and armed timers, so an unhandled `EADDRINUSE`
  // would exit the process with those still live and, on a real database, with
  // WAL files that were never checkpointed.
  let http: RunningHttpServer;
  try {
    http = await createHttpServer({
      deps: app.routeDeps,
      // The one thing that needs the `http.Server` and not the Express app: a
      // WebSocket lives on the `upgrade` event, which Express never sees. The
      // gateway is handed to `stop()` through the returned handle, so every open
      // voice session — and every provider session behind one — is closed before
      // the listener is, which is also the only reason `stop()` returns at all
      // with a microphone attached.
      attach: (server) => attachVoiceGateway(server, { deps: app.routeDeps, ear: app.voiceEar }),
    }).start();
  } catch (error) {
    await app.stop();
    throw error;
  }

  console.log(`  listening        : ${http.url}`);
  // Derived from `url` rather than from `host`, which is `0.0.0.0` when she is
  // bound to every interface — an address a browser cannot connect to.
  console.log(`  voice            : ${http.url.replace(/^http/, 'ws')}${VOICE_PATH}`);
  console.log('');
  console.log('  She is awake. Ctrl-C to stop.');
  console.log('');

  await holdUntilSignal(app, http);
}

/**
 * Keeps the process alive until a signal arrives, then shuts down once.
 *
 * The listener holds the event loop open by itself now, so this is no longer what
 * keeps her from exiting immediately after boot — it is what makes the exit
 * *orderly*. Without it a `SIGINT` would kill the process with an open database
 * handle and, on a real file, an unchecked WAL.
 *
 * The order matters and is the reverse of startup: the listener closes first so
 * no request can arrive at a subsystem that is being torn down, and only then
 * does `app.stop()` stop the flow and close the database. `close()` in
 * `server/http/server.ts` drops open SSE connections rather than waiting for
 * them, which is the only reason this returns at all with a browser attached.
 */
function holdUntilSignal(app: MadhuritaApp, http: RunningHttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('');
      console.log(`  ${signal} — stopping.`);
      void http
        .stop()
        .then(() => app.stop())
        .catch((error: unknown) => {
          console.error('  Shutdown failed:', error);
          process.exitCode = 1;
        })
        .finally(() => {
          resolve();
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // An unhandled rejection anywhere in her background work would otherwise
    // become a silent no-op under Node's default. Report it and shut down
    // deliberately rather than continuing in an unknown state.
    process.on('unhandledRejection', (reason: unknown) => {
      console.error('  Unhandled rejection:', reason);
      process.exitCode = 1;
      shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (error: unknown) => {
      console.error('  Uncaught exception:', error);
      process.exitCode = 1;
      shutdown('uncaughtException');
    });
  });
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    // A configuration mistake is an operator's problem, not a stack trace's.
    console.error('');
    console.error('  Madhurita did not start: her configuration is not valid.');
    console.error('');
    for (const issue of error.issues) {
      console.error(`    - ${issue}`);
    }
    console.error('');
    console.error('  See .env.example — every variable there is one she reads.');
    console.error('');
  } else {
    console.error('');
    console.error('  Madhurita did not start.');
    console.error('');
    console.error(error);
    console.error('');
  }
  process.exitCode = 1;
}
