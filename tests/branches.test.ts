import { describe, expect, it } from 'vitest';
import {
  branchKey,
  distanceKm,
  openingStatus,
  parseBranchPage,
  parseOpeningHours,
} from '../src/branches.js';

/** Synthetic geography: points due north of the origin, so distance is arithmetic. */
const ORIGIN = { latitude: 50, longitude: 14.5 };
const north = (km: number) => ({ latitude: 50 + km / 111.19, longitude: 14.5 });

describe('distance', () => {
  it('measures along a meridian', () => {
    expect(distanceKm(ORIGIN, north(15.76))).toBeCloseTo(15.76, 1);
    expect(distanceKm(ORIGIN, ORIGIN)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distanceKm(ORIGIN, north(24))).toBeCloseTo(distanceKm(north(24), ORIGIN), 6);
  });

  it('admits only what is inside the radius', () => {
    const within = [1, 12, 17, 40]
      .map((km) => ({ km, distance: distanceKm(ORIGIN, north(km)) }))
      .filter((entry) => entry.distance <= 15)
      .map((entry) => entry.km);
    expect(within).toEqual([1, 12]);
  });
});

describe('opening hours', () => {
  const week = ['Mo 07:00 - 20:00', 'Sa 08:00 - 18:00', 'Su 00:00 - 00:00'];

  it('reads a normal day', () => {
    expect(parseOpeningHours(['Mo 07:00 - 20:00'])).toEqual([{ day: 1, opens: 420, closes: 1200 }]);
  });

  it('treats an equal pair as closed all day, not round the clock', () => {
    // "Su 00:00 - 00:00" is how Kupi writes closed; the other reading sends people to a
    // locked door.
    expect(parseOpeningHours(['Su 00:00 - 00:00'])).toEqual([]);
    expect(openingStatus(week, new Date('2026-08-30T08:00:00Z')).open).toBe(false);
  });

  it('keeps hours that run past midnight', () => {
    expect(parseOpeningHours(['Fr 22:00 - 02:00'])[0]?.closes).toBe(1560);
  });

  it('says when it closes and how long is left', () => {
    const status = openingStatus(week, new Date('2026-08-31T17:40:00Z'));
    expect(status).toMatchObject({ open: true, closesAt: '20:00', minutesUntilClose: 20 });
  });

  it('says when it opens again', () => {
    expect(openingStatus(week, new Date('2026-08-31T04:00:00Z'))).toMatchObject({
      open: false,
      opensAt: '07:00',
    });
  });

  it('reports unknown rather than closed when nothing was published', () => {
    expect(openingStatus([]).open).toBeNull();
  });
});

const BRANCH_HTML = `<!doctype html><html><body>
<script type="application/ld+json">
{"@type":"LocalBusiness","name":"Penny Market Mesto","brand":"Penny Market",
 "address":{"addressLocality":"Mesto","streetAddress":"Hlavni","addressCountry":"Česká republika"},
 "openingHours":["Mo 07:00 - 20:00"]}
</script>
<script>var markerPosition = { "lat": 50.0, "lng": 14.5, "show": 1, "id": 1142 }</script>
</body></html>`;

describe('branch pages', () => {
  it('reads the address, coordinates and Kupi branch id', () => {
    const branch = parseBranchPage(BRANCH_HTML, 'https://www.kupi.cz/obchod/penny/penny-mesto');
    expect(branch).toMatchObject({
      id: '1142',
      chain: 'Penny Market',
      coordinates: { latitude: 50, longitude: 14.5 },
    });
    expect(branch?.address).toMatchObject({ city: 'Mesto', street: 'Hlavni' });
  });

  it('keeps a branch without coordinates, but unlocated', () => {
    const branch = parseBranchPage(
      BRANCH_HTML.replace(/var markerPosition[^\n]*/u, ''),
      'https://www.kupi.cz/obchod/p/p',
    );
    // Without coordinates nothing may be claimed about distance.
    expect(branch?.coordinates).toBeNull();
  });

  it('returns null for a page that is not a branch', () => {
    expect(
      parseBranchPage('<html><body>nic</body></html>', 'https://www.kupi.cz/obchod/x'),
    ).toBeNull();
  });

  it('identifies one shop reached through different URLs as the same', () => {
    const a = parseBranchPage(BRANCH_HTML, 'https://www.kupi.cz/obchod/penny/penny-mesto')!;
    const b = parseBranchPage(BRANCH_HTML, 'https://www.kupi.cz/obchod/penny/jinak')!;
    expect(branchKey(a)).toBe(branchKey(b));
  });
});
