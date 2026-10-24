// Read-only, local, aggregate counters. Does not observe text or start the bot.
import { readPrivacyHitCounters } from '../src/privacy-hit-counters.js';
console.log(JSON.stringify(readPrivacyHitCounters(),null,2));
