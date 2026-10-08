import { env } from "../env";
import { sleep } from "../util";

export class HfrBlockedError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HfrBlockedError";
  }
}

export interface HfrClientOptions {
  baseUrl?: string;
  rateMs?: number;
  contactEmail?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const LIST_PAGE_SIZE = 50;

/** Empty filter params the list endpoint expects. */
const LIST_BASE_PARAMS: Record<string, string> = {
  search_by: "fac_name",
  facility_name: "",
  region: "",
  district: "",
  council: "",
  ward: "",
  village_mtaa: "",
  facility_type: "",
  ownership_category: "",
  ownership_authority: "",
  fbo_denomination: "",
  moh_authority: "",
  Services_category: "",
  Services_list: "",
};

/**
 * Polite client for the HFR portal:
 * - one request at a time, at least `rateMs` apart (process-wide)
 * - XHR header (the portal returns partial HTML only with it)
 * - timeout + retry with exponential backoff on network errors, 5xx and 429
 * - 403 / repeated 429 raise HfrBlockedError so the runner can pause
 */
export class HfrClient {
  private baseUrl: string;
  private rateMs: number;
  private contactEmail: string;
  private timeoutMs: number;
  private retries: number;
  private fetchImpl: typeof fetch;
  private sleepImpl: (ms: number) => Promise<void>;
  private now: () => number;
  private static lastRequestAt: number | null = null;
  private static chain: Promise<void> = Promise.resolve();
  requestCount = 0;

  constructor(opts: HfrClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? env.hfrBaseUrl;
    this.rateMs = opts.rateMs ?? env.hfrRateMs;
    this.contactEmail = opts.contactEmail ?? env.hfrContactEmail;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.now = opts.now ?? Date.now;
  }

  static resetThrottle() {
    HfrClient.lastRequestAt = null;
    HfrClient.chain = Promise.resolve();
  }

  private async throttle() {
    // Serialise all requests in this process and space them out.
    const prev = HfrClient.chain;
    let release!: () => void;
    HfrClient.chain = new Promise<void>((r) => (release = r));
    await prev;
    const wait = HfrClient.lastRequestAt === null ? 0 : HfrClient.lastRequestAt + this.rateMs - this.now();
    if (wait > 0) await this.sleepImpl(wait);
    HfrClient.lastRequestAt = this.now();
    release();
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": `HFR-Pipeline/1.0 (data quality research; contact: ${this.contactEmail})`,
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      ...extra,
    };
  }

  url(route: string, params: Record<string, string | string[]> = {}): string {
    const u = new URL(this.baseUrl);
    u.searchParams.set("r", route);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async request(url: string, init: RequestInit = {}): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleepImpl(2000 * 2 ** (attempt - 1));
      await this.throttle();
      this.requestCount++;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          headers: this.headers((init.headers as Record<string, string>) ?? {}),
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
        });
        if (res.status === 403) throw new HfrBlockedError(`HFR portal refused the request (403)`, 403);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new HfrBlockedError(`HFR portal returned ${res.status}`, res.status);
          continue;
        }
        if (!res.ok) throw new Error(`HFR portal returned ${res.status} for ${url}`);
        return await res.text();
      } catch (e) {
        if (e instanceof HfrBlockedError && e.status === 403) throw e;
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  get(route: string, params: Record<string, string | string[]> = {}) {
    return this.request(this.url(route, params));
  }

  post(route: string, form: Record<string, string>) {
    return this.request(this.url(route), {
      method: "POST",
      body: new URLSearchParams(form).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    });
  }

  // ---- Endpoints -------------------------------------------------------

  /** One page of the facility list. `page` is 1-based. */
  listPage(opts: { page: number; region?: string; ward?: string }) {
    const params: Record<string, string | string[]> = {
      ...LIST_BASE_PARAMS,
      "per-page": String(LIST_PAGE_SIZE),
      page: String(opts.page),
      sort: "facility_identifier_number",
    };
    if (opts.region) {
      delete params.region;
      params["region[]"] = [opts.region];
    }
    if (opts.ward) {
      delete params.ward;
      params["ward[]"] = [opts.ward];
    }
    return this.get("portal/health-facility-list", params);
  }

  detail(facilityCode: string) {
    return this.get("portal/facility-detail", { facility_code: facilityCode });
  }

  coords(hfrId: number) {
    return this.get("portal/facility-operatingmapview", { condition: String(hfrId) });
  }

  services(hfrId: number) {
    return this.get("portal/facility-service", { id: String(hfrId) });
  }

  /** The advanced-search page, which carries the region list. */
  advancedSearch() {
    return this.get("portal/advanced-search");
  }

  /** Children of an admin unit: level 2 districts, 3 councils, 4 wards, 5 villages. */
  adminChildren(level: 2 | 3 | 4 | 5, parentCode: string) {
    const route = { 2: "portal/districts", 3: "portal/councils", 4: "portal/wards", 5: "portal/villages" }[level];
    return this.post(route, { "depdrop_parents[]": parentCode, "depdrop_all_params[x]": parentCode });
  }
}
