interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Chrome Web Store — public extension listing data: a single extension by id,
 * free-text search, and extensions by a publisher. Fleet #3087.
 *
 * SOURCE: there is no public read API. Google's official Chrome Web Store API
 * (chromewebstore.googleapis.com) only manages the CALLER's OWN published
 * items (OAuth, developer-scoped) — it cannot look up someone else's
 * extension. This pack instead reads the same public pages a browser does:
 *
 *   https://chromewebstore.google.com/detail/<any-slug>/<32-char-id>
 *   https://chromewebstore.google.com/search/<query>
 *
 * Public data, no login, no key.
 *
 * EDGE-PROBED FIRST, from a throwaway Cloudflare Worker
 * (pw-probe-chrome-web-store-tiberio, deployed and deleted 2026-10-14), per
 * this task's own instruction that Google may serve Workers differently from
 * a laptop. It does not: both the detail page and the search page return 200
 * with the real listing DATA EMBEDDED IN THE INITIAL HTML, no challenge, no
 * empty shell. The Supabase egress-relay fallback (oklahoma-code's pattern)
 * was not needed.
 *
 * THE SLUG IS IGNORED BY GOOGLE. `/detail/<anything>/<id>` 301-redirects to
 * the canonical slug server-side regardless of what you put before the id —
 * confirmed with a deliberately wrong slug — so this pack never has to know
 * or guess the display slug, only the id.
 *
 * NOT-FOUND SIGNATURE: an id with no listing (or a removed one) still answers
 * 200, but the canonical slug Google redirects to is literally `empty-title`
 * and there is no `<h1>` and no matching data item in the page's embedded
 * data. That is the condition this pack treats as `extension_not_found` — a
 * 200 is not success here, the presence of a matching data item is.
 *
 * HOW THE DATA IS EMBEDDED: Google's "WIZ" framework serves page data as
 * `<script>AF_initDataCallback({key: 'ds:N', ..., data: [...]});</script>`
 * blocks, where N is NOT stable — it depends on how many other RPCs the page
 * made (measured: the real extension record was `ds:1` for one extension and
 * `ds:0` for another). So this pack does not hardcode a ds key: it extracts
 * EVERY `ds:*` block with a bracket-depth-aware scanner (the arrays nest
 * strings that can themselves contain `[`/`]`, so a naive regex on the
 * braces is wrong), JSON.parses each one (the array content is valid JSON —
 * Google's own `data:` array, not a JS literal with unquoted keys), then
 * walks the result recursively looking for an array whose element 0 is a
 * 32-character lowercase string restricted to a–p (Chrome's own extension-id
 * alphabet; a real id can never collide with ordinary store copy). That
 * array, wherever it's nested — once for a detail page, many layers deep for
 * a search page's result grid — is one extension's record, in one fixed
 * field order measured directly against two live extensions (uBlock Origin
 * Lite, Grammarly) on 2026-10-14:
 *
 *   0 id · 1 iconUrl (small) · 2 name · 3 rating · 4 ratingCount ·
 *   5 iconUrl (large) · 6 description · 7 homepage/website · 8..10 flags/null ·
 *   11 [categorySlug, null, categoryId] · 12..13 flags · 14 userCount ·
 *   15 flag · 16 iconUrl (another size) · 17 [publishedAtUnixSeconds, ...] ·
 *   18 the extension's OWN manifest.json, verbatim, as a string.
 *
 * Fields NOT in that data (publisher/developer name, version string, "last
 * updated" date, size, languages) are rendered server-side as plain visible
 * text next to a stable LABEL, inside the same HTML — e.g.
 * `<div>Version</div><div>14.1338.0</div>`, `<div>Updated</div><div>October
 * 14, 2026</div>`, and a `Developer` block carrying the EU trader-disclosure
 * name/address Google now requires on every listing. This pack anchors on
 * the LABEL TEXT ("Version", "Updated", "Size", "Languages", "Developer"),
 * not on Google's hashed class names, because the labels are the part of the
 * markup actually guaranteed to stay in English and stay put — the class
 * hashes already differed between two back-to-back fetches of the same page
 * in the probe.
 *
 * "BY PUBLISHER" HAS NO DEDICATED PUBLIC PAGE. Google does not publish a
 * "list this developer's extensions" endpoint or URL — the public search
 * page is the only public surface, and it has no developer filter. So
 * `chrome_web_store_by_publisher` runs the publisher's name through the same
 * search this pack's `chrome_web_store_search` uses, then opens each
 * candidate's own detail page to confirm the rendered `Developer` name
 * actually matches (case-insensitive substring) before including it — a
 * search hit on the word alone is not proof of authorship. This is honest
 * about being an approximation of "all": it is bounded to what Chrome Web
 * Store's own search surfaces for that query, which is the only view of
 * "all" that exists publicly. The tool description and README say so.
 *
 * USER-AGENT: honest (names this pack, no browser impersonation) but WITHOUT
 * the `(+https://pipeworx.io)` marker most packs in this repo append — this
 * task named an Akamai/Google precedent against that exact "+http" bot-marker
 * shape, and chromewebstore.google.com sits behind Google's own front end, so
 * this pack errs toward the plain form. Measured working either way in the
 * probe; kept plain per the instruction rather than re-deriving it.
 *
 * NO CATEGORY LIST OR OTHER FIXTURE IS BAKED INTO THIS FILE — every field
 * above is read live off the page on every call. The only module-scope
 * constants are the UA string and the two upstream URL templates.
 */


const UPSTREAM_NAME = 'Chrome Web Store';
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp-chrome-web-store/1.0)';

async function pwFetch(url: string): Promise<{ status: number; body: string; finalUrl: string }> {
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    },
    UPSTREAM_NAME,
  );
  const body = await res.text();
  return { status: res.status, body, finalUrl: res.url };
}

// Chrome extension ids are exactly 32 lowercase letters restricted to a-p
// (base16 shifted into letters) — this can never match ordinary store copy,
// which is what makes "find the array that starts with one of these" a safe
// structural probe instead of a guess.
const EXTENSION_ID_RE = /^[a-p]{32}$/;

type RawItem = unknown[];

/**
 * Pulls every `AF_initDataCallback({key: 'ds:N', ..., data: [...]})` block
 * out of the page and JSON.parses each `data` array. The ds:N number is not
 * stable across pages (see file header), so every block is parsed and
 * searched rather than picking one by number.
 */
function extractDsBlocks(body: string): unknown[] {
  const out: unknown[] = [];
  const marker = /AF_initDataCallback\(\{key:\s*'ds:\d+'/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(body)) !== null) {
    const dataIdx = body.indexOf('data:', m.index);
    if (dataIdx < 0) continue;
    let i = dataIdx + 5;
    while (i < body.length && body[i] !== '[') i++;
    if (body[i] !== '[') continue;
    const arrStart = i;
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let escaped = false;
    for (; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === strCh) {
          inStr = false;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const raw = body.slice(arrStart, i);
    try {
      out.push(JSON.parse(raw));
    } catch {
      // A block that fails to parse is not this pack's problem to diagnose
      // further — callers walk every OTHER block that did parse. If none of
      // them yields a match, that is reported as upstream_parse, not this.
    }
  }
  return out;
}

/** Recursively finds every array whose element 0 is a 32-char extension id. */
function findItems(node: unknown, out: RawItem[] = [], seen = new Set<unknown>()): RawItem[] {
  if (Array.isArray(node)) {
    if (seen.has(node)) return out;
    seen.add(node);
    if (typeof node[0] === 'string' && EXTENSION_ID_RE.test(node[0] as string) && node.length >= 15) {
      out.push(node as RawItem);
    }
    for (const child of node) findItems(child, out, seen);
  }
  return out;
}

interface ParsedExtension {
  id: string;
  name: string;
  description: string | null;
  rating: number | null;
  ratingCount: number | null;
  userCount: number | null;
  website: string | null;
  category: string | null;
  manifestVersion: string | null;
}

function parseItem(item: RawItem): ParsedExtension {
  const cat = item[11];
  return {
    id: String(item[0]),
    name: typeof item[2] === 'string' ? (item[2] as string) : '',
    description: typeof item[6] === 'string' ? (item[6] as string) : null,
    rating: typeof item[3] === 'number' ? (item[3] as number) : null,
    ratingCount: typeof item[4] === 'number' ? (item[4] as number) : null,
    userCount: typeof item[14] === 'number' ? (item[14] as number) : null,
    website: typeof item[7] === 'string' ? (item[7] as string) : null,
    category: Array.isArray(cat) && typeof cat[0] === 'string' ? (cat[0] as string) : null,
    manifestVersion: (() => {
      const manifestStr = item[18];
      if (typeof manifestStr !== 'string') return null;
      try {
        const manifest = JSON.parse(manifestStr);
        return typeof manifest.version === 'string' ? manifest.version : null;
      } catch {
        return null;
      }
    })(),
  };
}

/** Pulls `<label>LABEL</div><div ...>VALUE</div>` text next to a stable label. */
function labelValue(body: string, label: string): string | null {
  const re = new RegExp(`>${label}</div><div[^>]*>([^<]+)</div>`);
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

/** The "Developer" panel: EU trader-disclosure name, on its own line before the address. */
function developerName(body: string): string | null {
  const idx = body.indexOf('>Developer</div>');
  if (idx < 0) return null;
  const chunk = body.slice(idx, idx + 600);
  const m = /<div class="[^"]*">([^<]+)<br/.exec(chunk);
  return m ? m[1].trim() : null;
}

async function fetchDetailById(id: string): Promise<{
  found: boolean;
  parsed: ParsedExtension | null;
  body: string;
  finalUrl: string;
  status: number;
}> {
  // The slug is ignored server-side (see file header) — "_" is a placeholder.
  const url = `https://chromewebstore.google.com/detail/_/${encodeURIComponent(id)}`;
  const { status, body, finalUrl } = await pwFetch(url);
  if (status !== 200) {
    throw new Error(
      `upstream_down: ${UPSTREAM_NAME} answered HTTP ${status} for extension id ${id} at ${url} — this is a transport failure, not "not found".`,
    );
  }
  const blocks = extractDsBlocks(body);
  const items = blocks.flatMap((b) => findItems(b));
  const match = items.find((it) => it[0] === id);
  if (!match) {
    return { found: false, parsed: null, body, finalUrl, status };
  }
  return { found: true, parsed: parseItem(match), body, finalUrl, status };
}

async function toolExtension(args: Record<string, unknown>): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!EXTENSION_ID_RE.test(id)) {
    throw new Error(
      `bad_request: "id" must be the 32-character Chrome Web Store extension id (letters a-p only), e.g. "cjpalhdlnbpafiamejdnhcphjbkeiagm". Got: ${JSON.stringify(args.id)}.`,
    );
  }
  const { found, parsed, body, finalUrl } = await fetchDetailById(id);
  if (!found || !parsed) {
    return {
      found: false,
      id,
      error: `extension_not_found: no live Chrome Web Store listing for id ${id} (checked ${finalUrl}). The extension may have been removed or never existed.`,
    };
  }
  const publisher = developerName(body);
  const version = labelValue(body, 'Version');
  const updated = labelValue(body, 'Updated');
  const size = labelValue(body, 'Size');
  const languages = labelValue(body, 'Languages');
  if (!parsed.name && !publisher && !version) {
    // Defensive: a page that matched an id but yielded nothing readable is a
    // parse failure, never a silent empty success (docs/silent-zero-policy.md).
    throw new Error(
      `upstream_parse: ${UPSTREAM_NAME} detail page for ${id} (${finalUrl}, body ${body.length} chars) matched a data item but every field came back empty. Likely a page-shape change — see this pack's file header for the field-index map it expects.`,
    );
  }
  return {
    found: true,
    id,
    name: parsed.name || null,
    publisher,
    description: parsed.description,
    rating: parsed.rating,
    ratingCount: parsed.ratingCount,
    userCount: parsed.userCount,
    version: version ?? parsed.manifestVersion,
    lastUpdated: updated,
    category: parsed.category,
    website: parsed.website,
    size,
    languages,
    url: finalUrl,
    source: 'Google Chrome Web Store public listing page',
  };
}

async function toolSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('bad_request: "query" is required and must be non-empty.');
  }
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 20) || 20));
  const url = `https://chromewebstore.google.com/search/${encodeURIComponent(query)}`;
  const { status, body, finalUrl } = await pwFetch(url);
  if (status !== 200) {
    throw new Error(`upstream_down: ${UPSTREAM_NAME} answered HTTP ${status} for search "${query}" at ${url}.`);
  }
  const blocks = extractDsBlocks(body);
  const items = blocks.flatMap((b) => findItems(b));
  // De-dupe by id — the recursive walk can surface the same record via more
  // than one containing array shape on the search results page.
  const seenIds = new Set<string>();
  const results = [];
  for (const it of items) {
    const parsed = parseItem(it);
    if (seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    results.push(parsed);
    if (results.length >= limit) break;
  }
  if (results.length === 0) {
    // Zero matches for a real query is plausible, but zero when the page
    // shape has changed looks identical — tell the difference by whether we
    // found ANY parseable data blocks at all.
    if (blocks.length === 0) {
      throw new Error(
        `upstream_parse: ${UPSTREAM_NAME} search page for "${query}" (${finalUrl}, body ${body.length} chars) had zero parseable data blocks — likely a page-shape change, not an empty result set.`,
      );
    }
    return { query, count: 0, results: [], note: 'No extensions matched this search on Chrome Web Store.' };
  }
  return {
    query,
    count: results.length,
    results: results.map((r) => ({
      id: r.id,
      name: r.name || null,
      rating: r.rating,
      ratingCount: r.ratingCount,
      userCount: r.userCount,
      category: r.category,
      website: r.website,
    })),
    url: finalUrl,
    source: 'Google Chrome Web Store public search page',
  };
}

async function toolByPublisher(args: Record<string, unknown>): Promise<unknown> {
  const publisher = String(args.publisher ?? '').trim();
  if (!publisher) {
    throw new Error('bad_request: "publisher" is required and must be non-empty.');
  }
  const maxChecked = Math.max(1, Math.min(25, Number(args.max_checked ?? 10) || 10));
  const url = `https://chromewebstore.google.com/search/${encodeURIComponent(publisher)}`;
  const { status, body, finalUrl } = await pwFetch(url);
  if (status !== 200) {
    throw new Error(`upstream_down: ${UPSTREAM_NAME} answered HTTP ${status} for search "${publisher}" at ${url}.`);
  }
  const blocks = extractDsBlocks(body);
  const items = blocks.flatMap((b) => findItems(b));
  if (items.length === 0 && blocks.length === 0) {
    throw new Error(
      `upstream_parse: ${UPSTREAM_NAME} search page for "${publisher}" (${finalUrl}, body ${body.length} chars) had zero parseable data blocks — likely a page-shape change.`,
    );
  }
  const seenIds = new Set<string>();
  const candidates: ParsedExtension[] = [];
  for (const it of items) {
    const parsed = parseItem(it);
    if (seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    candidates.push(parsed);
    if (candidates.length >= maxChecked) break;
  }
  const needle = publisher.toLowerCase();
  const confirmed: Array<ParsedExtension & { publisher: string | null; version: string | null; lastUpdated: string | null }> = [];
  for (const c of candidates) {
    const detail = await fetchDetailById(c.id);
    if (!detail.found) continue;
    const devName = developerName(detail.body);
    if (!devName || !devName.toLowerCase().includes(needle)) continue;
    confirmed.push({
      ...c,
      publisher: devName,
      version: labelValue(detail.body, 'Version'),
      lastUpdated: labelValue(detail.body, 'Updated'),
    });
  }
  return {
    publisher,
    checked: candidates.length,
    confirmedCount: confirmed.length,
    extensions: confirmed.map((c) => ({
      id: c.id,
      name: c.name || null,
      publisher: c.publisher,
      userCount: c.userCount,
      rating: c.rating,
      ratingCount: c.ratingCount,
      version: c.version,
      lastUpdated: c.lastUpdated,
      category: c.category,
      website: c.website,
    })),
    note:
      'Chrome Web Store has no public "list a developer\'s extensions" page. This runs the publisher name through the public search and keeps only results whose own listing confirms that publisher in its Developer disclosure — it is bounded to what that search surfaces, not a guaranteed-complete catalog of everything the publisher has shipped.',
    source: 'Google Chrome Web Store public search page, cross-checked against each result\'s own listing',
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'chrome_web_store_extension',
    description:
      'Chrome Web Store listing for ONE extension by its 32-character id: name, publisher, rating, rating count, user count, version, last-updated date, category, website. Public listing data, no login.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The extension\'s 32-character Chrome Web Store id, e.g. "cjpalhdlnbpafiamejdnhcphjbkeiagm" (from its store URL).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'chrome_web_store_search',
    description:
      'Free-text search of the Chrome Web Store: matching extensions with id, name, rating, rating count, user count, category, website. PLG/adoption signal — what tools people are actually installing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. "ad blocker" or "grammar checker".' },
        limit: { type: 'number', description: 'Max results to return (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'chrome_web_store_by_publisher',
    description:
      'Extensions on the Chrome Web Store attributed to one publisher/developer name, confirmed against each listing\'s own developer disclosure. Bounded by Chrome Web Store\'s own search — there is no public per-developer listing page, so this is an approximation of "all", not a guaranteed-complete catalog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        publisher: { type: 'string', description: 'Publisher/developer name as it appears on a listing, e.g. "Grammarly".' },
        max_checked: { type: 'number', description: 'Max search results to open and check (default 10, max 25).' },
      },
      required: ['publisher'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'chrome_web_store_extension':
      return toolExtension(args);
    case 'chrome_web_store_search':
      return toolSearch(args);
    case 'chrome_web_store_by_publisher':
      return toolByPublisher(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
