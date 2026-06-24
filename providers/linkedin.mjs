// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — hits the PUBLIC guest jobs endpoint that LinkedIn's own
// logged-out UI uses (no auth, no API key):
//
//   https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//     ?keywords=<kw>&location=<loc>&f_TPR=<range>&sortBy=DD&start=<n>
//
// It returns ~10 job cards of HTML per call. We parse title, company, location,
// the canonical /jobs/view/<id> URL, and the posting date (<time datetime>).
// scan.mjs then applies title_filter + location_filter + freshness_filter +
// dedup, exactly like every other source. postedAt feeds --last-24h / --last-7d.
//
// Why this instead of `site:linkedin.com/jobs` WebSearch queries: LinkedIn
// deindexes job permalinks from third-party search engines, so those queries
// return nothing through most CLIs' web search. This guest endpoint is the
// reliable, login-free surface.
//
// ⚠️ Caveats:
//   - Unofficial endpoint: LinkedIn may rate-limit (HTTP 429) unauthenticated
//     bursts. Keep `pages` small and the number of searches modest. The
//     provider sleeps briefly between requests and tolerates partial failures.
//   - LinkedIn ToS restricts automated access. This uses only the public
//     logged-out surface and stays low-volume; use responsibly.
//
// Configure via a `job_boards` entry:
//
//   - name: LinkedIn — DevOps/Cloud (EU + Gulf)
//     provider: linkedin
//     enabled: true
//     linkedin:
//       tpr: r604800            # time-posted range: r86400=24h, r604800=7d, r2592000=30d, '' = any
//       pages: 2               # 10 results per page (default 1, max 10)
//       sortByDate: true       # sortBy=DD (newest first); default true
//       searches:              # required, 1+ entries
//         - { keywords: "DevOps Engineer", location: "European Union" }
//         - { keywords: "Cloud Engineer",  location: "United Arab Emirates" }

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 10;       // LinkedIn returns ~10 cards per `start` step
const MAX_PAGES = 10;       // safety cap (100 results per search)
const REQUEST_GAP_MS = 400; // polite spacing to dodge rate limits

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {any} val @param {number} def @param {number} min @param {number} max
 * @returns {number}
 */
function intInRange(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
/** @param {any} value @returns {number|undefined} */
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Decode the handful of HTML entities LinkedIn emits in titles/companies.
/** @param {any} s @returns {string} */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** @param {any} s @returns {string} */
function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

/**
 * Parse one LinkedIn guest-search HTML payload into normalized jobs.
 * Exported for unit tests. Tolerant of missing fields per card.
 * @param {string} html
 * @param {string} fallbackCompany
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseLinkedInJobsHtml(html, fallbackCompany) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  // Each job card is a <li> ... </li> segment; process those carrying a card.
  const segments = html.split(/<li[\s>]/i);
  for (const seg of segments) {
    if (!seg.includes('base-card__full-link') && !seg.includes('base-search-card')) continue;

    const urlMatch = seg.match(/base-card__full-link[^"]*"\s+href="([^"]+)"/i)
      || seg.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"]+)"/i);
    let url = urlMatch ? urlMatch[1] : '';
    // Strip tracking query string; keep the canonical /jobs/view/<slug-id>.
    const q = url.indexOf('?');
    if (q !== -1) url = url.slice(0, q);
    url = decodeEntities(url);
    if (!/^https:\/\/[a-z.]*linkedin\.com\/jobs\/view\//i.test(url)) continue;

    const titleMatch = seg.match(/base-search-card__title"[^>]*>([\s\S]*?)<\//i);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    if (!title) continue;

    const subMatch = seg.match(/base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i);
    const company = subMatch ? stripTags(subMatch[1]) : (fallbackCompany || '');

    const locMatch = seg.match(/job-search-card__location"[^>]*>([\s\S]*?)<\//i);
    const location = locMatch ? stripTags(locMatch[1]) : '';

    const dtMatch = seg.match(/datetime="([^"]+)"/i);
    const postedAt = dtMatch ? toEpochMs(dtMatch[1]) : undefined;

    out.push({ title, url, company, location, ...(postedAt != null ? { postedAt } : {}) });
  }
  return out;
}

/**
 * Reads + sanitizes the entry's `linkedin:` config block.
 * @param {{ linkedin?: any, name?: string }} entry
 */
export function parseLinkedInConfig(entry) {
  const cfg = (entry && entry.linkedin) || {};
  const rawSearches = Array.isArray(cfg.searches) ? cfg.searches : [];
  const searches = rawSearches
    .map((/** @type {any} */ s) => (s && typeof s === 'object') ? s : null)
    .filter(Boolean)
    .map((/** @type {any} */ s) => ({
      keywords: typeof s.keywords === 'string' ? s.keywords.trim() : '',
      location: typeof s.location === 'string' ? s.location.trim() : '',
      geoId: s.geoId != null ? String(s.geoId).trim() : '',
    }))
    .filter((/** @type {any} */ s) => s.keywords);
  return {
    searches,
    tpr: typeof cfg.tpr === 'string' ? cfg.tpr.trim() : '',
    pages: intInRange(cfg.pages, 1, 1, MAX_PAGES),
    sortByDate: cfg.sortByDate !== false, // default true
  };
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  async fetch(entry, ctx) {
    const { searches, tpr, pages, sortByDate } = parseLinkedInConfig(entry);
    if (!searches.length) {
      throw new Error(`linkedin: entry "${entry.name || '(unnamed)'}" has no linkedin.searches[] with keywords`);
    }

    const byUrl = new Map();
    const errors = [];
    let succeeded = 0;
    let first = true;

    for (const search of searches) {
      for (let page = 0; page < pages; page++) {
        if (!first) await sleep(REQUEST_GAP_MS);
        first = false;

        const params = new URLSearchParams();
        params.set('keywords', search.keywords);
        if (search.location) params.set('location', search.location);
        if (search.geoId) params.set('geoId', search.geoId);
        if (tpr) params.set('f_TPR', tpr);
        if (sortByDate) params.set('sortBy', 'DD');
        params.set('start', String(page * PAGE_SIZE));

        const url = `${SEARCH_URL}?${params.toString()}`;
        let html;
        try {
          // redirect:'error' prevents SSRF via server-side redirects; the host
          // is fixed (www.linkedin.com), so the final hostname stays locked.
          html = await ctx.fetchText(url, {
            redirect: 'error',
            timeoutMs: 15_000,
            headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
          });
          succeeded++;
        } catch (err) {
          const e = /** @type {any} */ (err);
          errors.push(`"${search.keywords}"${search.location ? ` @ ${search.location}` : ''} (start=${page * PAGE_SIZE}): ${(e && e.message) || e}`);
          break; // stop paging this search on error (likely 429) — move to next
        }

        const jobs = parseLinkedInJobsHtml(html, entry.name);
        for (const job of jobs) {
          if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        if (jobs.length < PAGE_SIZE) break; // last page for this search
      }
    }

    // Total outage = every request failed. A search that legitimately returns
    // zero cards is not an outage, so key off the success count.
    if (succeeded === 0 && errors.length) {
      throw new Error(`linkedin: all ${errors.length} request(s) failed — ${errors[0]}`);
    }

    return [...byUrl.values()];
  },
};

// ── Job-detail enrichment (full JD + criteria, login-free) ──────────
// scan.mjs stays zero-token (list only). For the PIPELINE step, evaluating a
// LinkedIn URL needs the full description — but linkedin.com/jobs/view gates it
// behind login. LinkedIn's guest jobPosting endpoint returns the full JD with
// no auth:
//   https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<jobId>
// Use fetchLinkedInJobDetail() (or the linkedin-jd.mjs CLI) to enrich a URL.

const JOB_DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

/**
 * Extract the numeric LinkedIn job id from a URL or raw id.
 * Handles /jobs/view/<slug>-<id>, ?currentJobId=<id>, and bare numeric ids.
 * @param {string} idOrUrl
 * @returns {string|null}
 */
export function extractLinkedInJobId(idOrUrl) {
  const s = String(idOrUrl || '').trim();
  if (/^\d{6,}$/.test(s)) return s;
  const cur = s.match(/[?&]currentJobId=(\d{6,})/);
  if (cur) return cur[1];
  const view = s.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/);
  if (view) return view[1];
  const any = s.match(/(\d{8,})/);
  return any ? any[1] : null;
}

/** @param {any} s @returns {string} */
function stripToText(s) {
  return decodeEntities(
    String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|ul|ol|div|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Parse a LinkedIn guest jobPosting HTML page into structured detail.
 * Exported for unit tests. Missing fields come back as '' / [].
 * @param {string} html
 * @returns {{title: string, company: string, location: string, description: string, criteria: Record<string,string>, postedAt?: number}}
 */
export function parseLinkedInJobDetail(html) {
  if (typeof html !== 'string') {
    return { title: '', company: '', location: '', description: '', criteria: {} };
  }
  const titleM = html.match(/topcard__title[^>]*>([\s\S]*?)<\//i);
  const companyM = html.match(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i)
    || html.match(/topcard__flavor[^>]*>([\s\S]*?)<\//i);
  const locM = html.match(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\//i);
  const descM = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/description__text[^>]*>([\s\S]*?)<\/section>/i);
  const dtM = html.match(/datetime="([^"]+)"/i);

  /** @type {Record<string,string>} */
  const criteria = {};
  const critRe = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = critRe.exec(html)) !== null) {
    const key = decodeEntities(String(m[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    const val = decodeEntities(String(m[2]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    if (key) criteria[key] = val;
  }

  const postedAt = dtM ? toEpochMs(dtM[1]) : undefined;
  return {
    title: titleM ? decodeEntities(String(titleM[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) : '',
    company: companyM ? decodeEntities(String(companyM[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) : '',
    location: locM ? decodeEntities(String(locM[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) : '',
    description: descM ? stripToText(descM[1]) : '',
    criteria,
    ...(postedAt != null ? { postedAt } : {}),
  };
}

/**
 * Fetch + parse the full detail for one LinkedIn job (URL or id).
 * @param {string} idOrUrl
 * @param {{ fetchText: (url: string, opts?: any) => Promise<string> }} ctx
 */
export async function fetchLinkedInJobDetail(idOrUrl, ctx) {
  const id = extractLinkedInJobId(idOrUrl);
  if (!id) throw new Error(`linkedin: could not extract a job id from "${idOrUrl}"`);
  const html = await ctx.fetchText(`${JOB_DETAIL_URL}${id}`, {
    redirect: 'error',
    timeoutMs: 15_000,
    headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
  });
  return { id, ...parseLinkedInJobDetail(html) };
}
