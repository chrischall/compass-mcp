#!/usr/bin/env node
// compass-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared fetchproxy Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/chrischall/fetchproxy.
//   2. CompassClient.start() — brings the transport up. This MUST run
//      before `runMcp` connects stdio so the WS bridge is bound by the
//      time the host can issue tool calls.
//   3. runMcp() — builds the MCP server, applies every tool registrar,
//      prints the stderr banner, wires SIGINT/SIGTERM → client.close(),
//      and connects stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM the
// graceful-shutdown handler closes it so ports/connections don't leak
// between client restarts. The boilerplate boot (server construct +
// fixed registrar list + banner + signal handlers + stdio connect) is
// the fleet-wide `runMcp` from `@chrischall/mcp-utils` — compass keeps
// only what's compass-specific: the transport/client construction (which
// must come first) and the registrar list.
import { runMcp } from '@chrischall/mcp-utils';
import { CompassClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerSavedTools } from './tools/saved.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerHistoryTools } from './tools/history.js';
import { registerCompareTools } from './tools/compare.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerPhotosTools } from './tools/photos.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerByAddressTools } from './tools/by-address.js';
import { registerBulkGetTools } from './tools/bulk-get.js';
import { registerResolveAddressesTools } from './tools/resolve-addresses.js';
import { registerSessionTools } from './tools/session.js';
import { registerComparableRentalsTools } from './tools/comparable-rentals.js';
import { registerAgentListingsTools } from './tools/agent-listings.js';

const VERSION = '0.11.3'; // x-release-please-version

const port = process.env.COMPASS_WS_PORT
  ? Number(process.env.COMPASS_WS_PORT)
  : undefined;

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new CompassClient({ transport });
// Bring the WS bridge up before stdio connects (runMcp does the connect).
await client.start();

await runMcp<CompassClient>({
  name: 'compass-mcp',
  version: VERSION,
  deps: client,
  tools: [
    registerSearchTools,
    registerPropertyTools,
    registerSavedTools,
    registerMortgageTools,
    registerHistoryTools,
    registerCompareTools,
    registerAffordabilityTools,
    registerPhotosTools,
    registerHealthcheckTools,
    registerByAddressTools,
    registerBulkGetTools,
    registerResolveAddressesTools,
    registerSessionTools,
    registerComparableRentalsTools,
    registerAgentListingsTools,
  ],
  banner:
    `[compass-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into compass.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  shutdown: { onSignal: () => client.close() },
});
