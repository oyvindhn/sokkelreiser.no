// Kjør: node --test tests/*.test.js
// Syntetiske testdata. Ingen ekte reiser, personer eller rigger.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/core.js");

const LOG = [
  ["Eksport"], [],
  ["Date", "Year", "Direction", "From", "To", "Route no.", "Booking status", "Offshore installation"],
  [45000, 2023, "Outbound", "BASEA", "RIG1", "H1", "Confirmed", "Test Rig One"],
  [45014, 2023, "Inbound", "RIG1", "BASEA", "H2", "Confirmed", "Test Rig One"],
  [45042, 2023, "Outbound", "BASEA", "RIG1", "H3", "Confirmed", "Test Rig One"],
  [45049, 2023, "Field", "RIG1", "PLAT", "H4", "Confirmed", "Alpha Platform"],
  [45056, 2023, "Inbound", "PLAT", "BASEB", "H5", "Confirmed", "Alpha Platform"],
  [45070, 2023, "Outbound", "BASEB", "PLAT", "H6", "Cancelled", "Alpha Platform"],
];

function legs(dir = true) {
  const t = C.analyseTables([{ name: "Offshore History", rows: LOG }])[0];
  const l = C.buildLegs(t, t.cols, false);
  return dir ? l : l.map((x) => ({ ...x, dir: "" }));
}

test("finner overskriftsrad og kolonner", () => {
  const t = C.analyseTables([{ name: "Offshore History", rows: LOG }])[0];
  assert.equal(t.cols.date, 0);
  assert.equal(t.cols.from, 3);
  assert.equal(t.cols.to, 4);
  assert.equal(t.cols.inst, 7);
  assert.equal(t.rowCount, 6);
});

test("datoformater", () => {
  for (const v of ["2016-08-02 07:30", "2.8.16", "02/08/2016", 42584, "2 aug. 2016"]) assert.equal(C.parseDate(v), "2016-08-02");
});

test("skiller installasjoner fra landbaser, med og uten retning", () => {
  for (const dir of [true, false]) {
    const k = Object.fromEntries(C.derivePlaces(legs(dir)).map((p) => [p.key, p.guess]));
    assert.deepEqual(k, { RIG1: "installation", BASEA: "base", PLAT: "installation", BASEB: "base" }, `retning=${dir}`);
  }
});

test("bygger opphold og hopper over kansellerte reiser", () => {
  const l = legs();
  const k = Object.fromEntries(C.derivePlaces(l).map((p) => [p.key, p.guess]));
  const s = C.buildStays(l, (x) => k[x]);
  assert.deepEqual(s.map((x) => [x.key, x.start, x.end, x.days]), [
    ["RIG1", "2023-03-15", "2023-03-29", 14],
    ["RIG1", "2023-04-26", "2023-05-03", 7],
    ["PLAT", "2023-05-03", "2023-05-10", 7],
  ]);
});

test("navnetreff mot Sodir", () => {
  assert.equal(C.nameScore("Maersk Guardian", "MÆRSK GUARDIAN"), 1);
  assert.ok(C.nameScore("Noble Interceptor", "MAERSK INTERCEPTOR") >= 0.45);
  assert.ok(C.nameScore("Sleipner", "SLEIPNER R") < 0.9);
});

test("finner riggens lokasjon på en dato", () => {
  const wb = (name, e, c, lat, lon, field) => C.normWellbore({ wlbWellboreName: name, wlbWell: name, wlbEntryDate: Date.parse(e), wlbCompletionDate: Date.parse(c), wlbNsDecDeg: lat, wlbEwDecDeg: lon, wlbField: field, fclNpdidFacilityDrilling: 1 });
  const tl = C.rigTimeline("1", [
    wb("1/1-1", "2022-12-01", "2023-01-20", 57, 2, "FOO"),
    wb("1/1-2", "2023-02-01", "2023-03-01", 57.001, 2.001, "FOO"),
    wb("2/2-1", "2023-03-05", "2023-05-01", 58, 3, ""),
  ]);
  assert.equal(tl.sites.length, 2);
  assert.equal(tl.visits.length, 2);
  const hit = C.locateOnRig(tl, "2023-03-15", "2023-03-29");
  assert.equal(hit[0].site.well, "2/2-1");
  assert.equal(hit[0].conf, "sikker");
  // pause mellom to brønner på samme lokasjon regnes som samme opphold
  assert.equal(C.locateOnRig(tl, "2023-01-25", "2023-01-28")[0].conf, "sikker");
  assert.equal(C.locateOnRig(tl, "2023-05-10", "2023-05-15")[0].conf, "trolig");
  assert.equal(C.locateOnRig(tl, "2023-06-15", "2023-06-20")[0].conf, "usikker");
  assert.equal(C.locateOnRig(tl, "2024-06-15", "2024-06-20")[0].conf, "ukjent");
});

test("CSV med semikolon og anførselstegn", () => {
  assert.deepEqual(C.parseCSV('Dato;Installasjon\n01.02.2020;"Rig; X"\n'), [["Dato", "Installasjon"], ["01.02.2020", "Rig; X"]]);
});
