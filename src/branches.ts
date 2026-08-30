import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import type { KupiClient } from './client.js';
import { comparable, text } from './normalize.js';
import type { Branch, NearbyBranch, OpeningStatus, Origin } from './types.js';

/**
 * Where the shops actually are.
 *
 * Kupi.cz branch pages publish coordinates directly, so no external geocoder is involved.
 * What they do not publish is prices, which is why this layer can prove a branch is nearby
 * but never that a promotion applies at it.
 */

const EARTH_RADIUS_KM = 6371.0088;
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const PRAGUE = 'Europe/Prague';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/**
 * Great-circle distance. This is straight-line, not driving: a shop 10 km away across a
 * river can be a 25 km drive, so anything shown to a caller must say which it is.
 */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const fromLat = radians(from.latitude);
  const toLat = radians(to.latitude);
  const deltaLat = toLat - fromLat;
  const deltaLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))) * 100) / 100;
}

// --- opening hours -----------------------------------------------------------

interface DayHours {
  day: number;
  opens: number;
  closes: number;
}

/**
 * Reads entries such as `"Mo 07:00 - 20:00"`.
 *
 * `"Su 00:00 - 00:00"` is how Kupi writes *closed all day*: reading an equal pair as
 * round-the-clock sends someone to a locked door. A closing time genuinely before the
 * opening time runs past midnight and is kept.
 */
export function parseOpeningHours(entries: string[]): DayHours[] {
  const parsed: DayHours[] = [];
  for (const entry of entries) {
    const match = /^\s*([A-Za-z]{2})\s+(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*$/u.exec(
      entry,
    );
    if (!match) continue;
    const code = (match[1] ?? '').charAt(0).toUpperCase() + (match[1] ?? '').slice(1).toLowerCase();
    const day = DAYS.indexOf(code);
    const opens = Number(match[2]) * 60 + Number(match[3]);
    const closes = Number(match[4]) * 60 + Number(match[5]);
    if (day < 0 || !Number.isFinite(opens) || !Number.isFinite(closes)) continue;
    if (opens === closes) continue;
    parsed.push({ day, opens, closes: closes < opens ? closes + 1440 : closes });
  }
  return parsed;
}

function clock(minutes: number): string {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function pragueNow(now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PRAGUE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const day = DAYS.indexOf(value('weekday').slice(0, 2));
  return {
    day: day < 0 ? now.getDay() : day,
    minutes: (Number(value('hour')) % 24) * 60 + Number(value('minute')),
  };
}

/**
 * Whether a shop is open, according to its published regular hours only. Holidays and
 * one-off closures are not in the source, so this is never a promise about the door.
 */
export function openingStatus(entries: string[], now: Date = new Date()): OpeningStatus {
  const closed: OpeningStatus = {
    open: null,
    closesAt: null,
    opensAt: null,
    minutesUntilClose: null,
  };
  const hours = parseOpeningHours(entries);
  if (hours.length === 0) return closed;

  const { day, minutes } = pragueNow(now);
  const today = hours.filter((entry) => entry.day === day);
  // Yesterday's hours can still cover the small hours of today.
  const overnight = hours
    .filter((entry) => entry.day === (day + 6) % 7 && entry.closes > 1440)
    .map((entry) => ({ ...entry, opens: 0, closes: entry.closes - 1440 }));

  for (const entry of [...today, ...overnight]) {
    if (minutes >= entry.opens && minutes < entry.closes) {
      return {
        open: true,
        closesAt: clock(entry.closes),
        opensAt: null,
        minutesUntilClose: entry.closes - minutes,
      };
    }
  }

  const later = today
    .filter((entry) => entry.opens > minutes)
    .sort((left, right) => left.opens - right.opens)[0];
  return { ...closed, open: false, opensAt: later ? clock(later.opens) : null };
}

// --- branch pages ------------------------------------------------------------

const jsonText = (value: unknown): string => (typeof value === 'string' ? text(value) : '');

/**
 * Extracts a branch from its page: schema.org `LocalBusiness` for the address, the Leaflet
 * marker script for the coordinates and Kupi's own branch id.
 */
export function parseBranchPage(html: string, sourceUrl: string): Branch | null {
  const $ = cheerio.load(html);
  let data: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_index, element) => {
    if (data) return;
    try {
      const parsed = JSON.parse($(element).text()) as Record<string, unknown>;
      if (parsed['@type'] === 'LocalBusiness') data = parsed;
    } catch {
      // Malformed JSON-LD is simply not a usable source; keep looking.
    }
  });
  if (!data) return null;

  const record = data as Record<string, unknown>;
  const address = (record.address ?? {}) as Record<string, unknown>;
  const city = jsonText(address.addressLocality);
  const name = jsonText(record.name);
  if (!name || !city) return null;

  let coordinates: Coordinates | null = null;
  let id: string | null = null;
  const marker = /var\s+markerPosition\s*=\s*(\{[^}]*\})/u.exec(html);
  if (marker?.[1]) {
    try {
      const position = JSON.parse(marker[1]) as { lat?: number; lng?: number; id?: number };
      if (typeof position.lat === 'number' && typeof position.lng === 'number') {
        coordinates = { latitude: position.lat, longitude: position.lng };
      }
      if (position.id !== undefined) id = String(position.id);
    } catch {
      // No usable marker leaves the branch known but unlocated, which excludes it below.
    }
  }

  const chainFromCatalog = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((element) => {
      const raw = $(element).text();
      const match = /"name"\s*:\s*"([^"]*?)\s+leták/u.exec(raw);
      return match?.[1] ? [text(match[1])] : [];
    })[0];

  return {
    id,
    // The leaflet catalog names the exact format ("Albert Hypermarket") where the brand
    // field often says only "Albert".
    chain: chainFromCatalog || jsonText(record.brand) || name,
    name,
    url: sourceUrl,
    address: {
      street: jsonText(address.streetAddress) || null,
      city,
      country: jsonText(address.addressCountry) || 'Česká republika',
    },
    coordinates,
    openingHours: Array.isArray(record.openingHours)
      ? record.openingHours.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/** Nearby branch links a branch page lists: its own siblings and other chains. */
function neighbourLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const paths = new Set<string>();
  $('a[href^="/obchod/"]').each((_index, element) => {
    const href = $(element).attr('href')?.trim();
    if (href && /^\/obchod\/[a-z0-9-]+\/[a-z0-9-]+$/u.test(href)) paths.add(href);
  });
  return [...paths];
}

/** Stable identity, so one shop reached through two pages is not counted twice. */
export function branchKey(branch: Branch): string {
  if (branch.id) return `id:${branch.id}`;
  return `addr:${comparable(branch.chain)}|${comparable(branch.address.street ?? '')}|${comparable(branch.address.city)}`;
}

const SNAPSHOT_FILE = 'data/store-branches.json';
/** Live pages one discovery may fetch. Each costs a rate-limit interval, so this is a
 * time budget: without it a cold start with no snapshot outlasts the caller's timeout. */
const FETCH_BUDGET = 12;
const MAX_BRANCHES = 60;
/** Branches just outside the radius are still fetched, so "just outside" is provable. */
const BUFFER_KM = 10;

export class BranchDirectory {
  private readonly cache = new Map<string, Branch | null>();
  private readonly snapshot = new Map<string, Branch>();
  readonly stats = { snapshotHits: 0, fetches: 0 };

  constructor(private readonly client: KupiClient) {}

  /** Loads a generated snapshot. Any failure is silent: it is only an optimisation. */
  loadSnapshot(file = SNAPSHOT_FILE): boolean {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const root of [process.cwd(), resolve(here, '..'), resolve(here, '../..')]) {
      try {
        const path = resolve(root, file);
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { branches?: Branch[] };
        for (const branch of parsed.branches ?? []) {
          if (branch?.chain && branch.address?.city && branch.url) {
            this.snapshot.set(branchKey(branch), branch);
          }
        }
        return this.snapshot.size > 0;
      } catch {
        // Try the next candidate root; a bad file must not stop the server.
      }
    }
    return false;
  }

  async get(path: string): Promise<Branch | null> {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;

    for (const branch of this.snapshot.values()) {
      if (new URL(branch.url).pathname === path) {
        this.stats.snapshotHits += 1;
        this.cache.set(path, branch);
        return branch;
      }
    }

    this.stats.fetches += 1;
    let branch: Branch | null;
    try {
      const page = await this.client.getPage(path);
      branch = parseBranchPage(page.html, page.sourceUrl);
    } catch {
      // Unreadable means unverified, which the caller must treat as "not proven nearby".
      branch = null;
    }
    this.cache.set(path, branch);
    return branch;
  }

  /**
   * The point a radius is measured from, taken from a branch in the requested town.
   * Never guessed: an unmatched name resolves to null so the caller can say so.
   */
  async resolveOrigin(name: string, paths: string[]): Promise<Origin | null> {
    const wanted = comparable(name);
    for (const path of paths) {
      const branch = await this.get(path);
      if (!branch?.coordinates || comparable(branch.address.city) !== wanted) continue;
      return {
        name: branch.address.city,
        coordinates: branch.coordinates,
        source: `kupi_branch:${new URL(branch.url).pathname.split('/').pop() ?? ''}`,
      };
    }
    return null;
  }

  /**
   * Branches near the origin, deduplicated and sorted by distance.
   *
   * Deliberately shallow: the seed pages plus one hop through what they link, capped by
   * count and by fetch budget so it can never become a crawl of the country.
   */
  async near(
    origin: Coordinates,
    seeds: string[],
    radiusKm: number,
    // Raised only by the offline snapshot script, where the caller's timeout does not apply.
    budget: { fetches?: number; branches?: number } = {},
  ): Promise<NearbyBranch[]> {
    const fetchBudget = budget.fetches ?? FETCH_BUDGET;
    const maxBranches = budget.branches ?? MAX_BRANCHES;
    const limit = radiusKm + BUFFER_KM;
    const found = new Map<string, NearbyBranch>();
    const budgetStart = this.stats.fetches;

    const consider = (branch: Branch): NearbyBranch | null => {
      if (!branch.coordinates) return null;
      const located: NearbyBranch = {
        ...branch,
        distanceKm: distanceKm(origin, branch.coordinates),
        opening: openingStatus(branch.openingHours),
        branchApplicability: 'assumed',
      };
      const key = branchKey(branch);
      const existing = found.get(key);
      if (!existing || located.distanceKm < existing.distanceKm) found.set(key, located);
      return located;
    };

    for (const branch of this.snapshot.values()) consider(branch);

    const visited = new Set<string>();
    let frontier = seeds;
    for (let hop = 0; hop < 2; hop += 1) {
      const next: string[] = [];
      for (const path of frontier) {
        if (visited.has(path) || found.size >= maxBranches) continue;
        if (this.stats.fetches - budgetStart >= fetchBudget) break;
        visited.add(path);
        const branch = await this.get(path);
        if (!branch) continue;
        const located = consider(branch);
        // Only expand through branches that are themselves plausibly close, and only when
        // there is no snapshot to expand from.
        if (hop === 0 && located && located.distanceKm <= limit && this.snapshot.size === 0) {
          try {
            const page = await this.client.getPage(path);
            next.push(...neighbourLinks(page.html).filter((link) => link !== path));
          } catch {
            // A page that will not load simply contributes no neighbours.
          }
        }
      }
      frontier = next;
      if (frontier.length === 0 || this.stats.fetches - budgetStart >= fetchBudget) break;
    }

    return [...found.values()]
      .filter((branch) => branch.distanceKm <= limit)
      .sort((left, right) => left.distanceKm - right.distanceKm);
  }
}

export interface Geography {
  origin: Origin | null;
  radiusKm: number | null;
  /** Chains with a verified branch inside the radius, normalised; null means no radius. */
  allowed: Set<string> | null;
  branchByChain: Map<string, NearbyBranch>;
  excluded: Array<{ chain: string; reason: string; distanceKm?: number }>;
}

export const noGeography = (radiusKm: number | null): Geography => ({
  origin: null,
  radiusKm,
  allowed: null,
  branchByChain: new Map(),
  excluded: [],
});

/**
 * Works out which chains have a verified branch within the radius.
 *
 * A chain whose branch cannot be located is excluded rather than assumed nearby, and an
 * origin that cannot be resolved disables the radius rather than inventing a distance.
 */
export async function resolveGeography(
  directory: BranchDirectory,
  input: {
    location?: string | undefined;
    radiusKm?: number | undefined;
    origin?: Coordinates | undefined;
  },
  pages: Array<{ branchLinks: Array<{ chain: string; path: string }>; chains: string[] }>,
): Promise<Geography> {
  const radiusKm = input.radiusKm;
  if (radiusKm === undefined) return noGeography(null);

  const links = new Map<string, string>();
  const requested = new Map<string, string>();
  for (const page of pages) {
    for (const link of page.branchLinks)
      if (!links.has(link.path)) links.set(link.path, link.chain);
    for (const chain of page.chains)
      if (!requested.has(comparable(chain))) requested.set(comparable(chain), chain);
  }

  const origin: Origin | null = input.origin
    ? {
        name: input.location?.trim() || 'zadané souřadnice',
        coordinates: input.origin,
        source: 'caller',
      }
    : input.location
      ? await directory.resolveOrigin(input.location, [...links.keys()])
      : null;
  if (!origin) return noGeography(radiusKm);

  const located = await directory.near(origin.coordinates, [...links.keys()], radiusKm);
  const allowed = new Set<string>();
  const branchByChain = new Map<string, NearbyBranch>();
  const excluded: Geography['excluded'] = [];
  const byChain = new Map<string, NearbyBranch[]>();

  for (const branch of located) {
    const key = comparable(branch.chain);
    byChain.set(key, [...(byChain.get(key) ?? []), branch]);
  }

  for (const [key, branches] of byChain) {
    // `located` is distance-sorted, so the first inside the radius is the nearest.
    const nearest = branches.find((branch) => branch.distanceKm <= radiusKm);
    if (nearest) {
      allowed.add(key);
      branchByChain.set(key, nearest);
    } else if (branches[0]) {
      excluded.push({
        chain: branches[0].chain,
        reason: 'nejbližší pobočka je mimo radius',
        distanceKm: branches[0].distanceKm,
      });
    }
  }

  for (const [key, chain] of requested) {
    if (allowed.has(key) || byChain.has(key)) continue;
    if (excluded.some((entry) => comparable(entry.chain) === key)) continue;
    excluded.push({ chain, reason: 'pobočku se nepodařilo ověřit' });
  }

  return { origin, radiusKm, allowed, branchByChain, excluded };
}
