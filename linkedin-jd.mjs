#!/usr/bin/env node
/**
 * linkedin-jd.mjs — fetch a LinkedIn job's full description + criteria via the
 * public guest jobPosting endpoint (no login). Use during /career-ops pipeline
 * to enrich a LinkedIn URL whose JD is otherwise gated behind login.
 *
 * Usage:
 *   node linkedin-jd.mjs "https://de.linkedin.com/jobs/view/devops-engineer-...-4410507735"
 *   node linkedin-jd.mjs 4410507735            # bare job id
 *   node linkedin-jd.mjs <url> --json          # machine-readable output
 */

import { makeHttpCtx } from './providers/_http.mjs';
import { fetchLinkedInJobDetail } from './providers/linkedin.mjs';

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: node linkedin-jd.mjs <linkedin-job-url|jobId> [--json]');
    process.exit(1);
  }

  let detail;
  try {
    detail = await fetchLinkedInJobDetail(target, makeHttpCtx());
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  const posted = detail.postedAt ? new Date(detail.postedAt).toISOString().slice(0, 10) : 'n/a';
  console.log(`# ${detail.title || '(no title)'}`);
  console.log(`**Company:** ${detail.company || 'n/a'}  |  **Location:** ${detail.location || 'n/a'}  |  **Posted:** ${posted}`);
  const crit = Object.entries(detail.criteria || {});
  if (crit.length) {
    console.log('');
    for (const [k, v] of crit) console.log(`- **${k}:** ${v}`);
  }
  console.log('\n---\n');
  console.log(detail.description || '(no description extracted)');
}

main();
