/**
 * Generates a strong internal API token. Nothing is printed to a log file and nothing is stored:
 * paste the value into `.env` as `INTERNAL_API_TOKEN` (and `API_INTERNAL_TOKEN` for the gateway).
 */

import { generateInternalToken } from '../http/server.js';

process.stdout.write(`${generateInternalToken()}\n`);
