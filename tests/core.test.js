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

/* ---------- MinDaVinci-eksport: Fra/Til er alt som finnes ---------- */
const MDV_HEAD = ["", "Dato", "Avg.", "Ank.", "Rutenr", "Fra", "Til", "Sjekket inn", "Ref.", "Firma", "Formål", "Reise type", "Bestillingsstatus"];
function mdvRows() {
  const rows = [MDV_HEAD];
  let d = 44927; // 2023-01-01
  const trip = (from, to, status = "Bekreftet") => rows.push(["", d, 0.3125, 0.3333, "R" + d, from, to, "Ja", "REF" + d, "Testfirma", "Arbeid", "Skytteltrafikk", status]);
  // BASEA flyr til fire installasjoner, BASEB til to. Hver tur er ut og hjem.
  for (const inst of ["I1", "I2", "I3", "I4"]) { trip("BASEA", inst); d += 14; trip(inst, "BASEA"); d += 20; }
  for (const inst of ["I5", "I6"]) { trip("BASEB", inst); d += 14; trip(inst, "BASEB"); d += 20; }
  trip("BASEA", "I1", "Kansellert"); d += 3;
  return rows;
}

test("MinDaVinci-kolonner gjenkjennes uten valg", () => {
  const t = C.analyseTables([{ name: "Ark1", rows: mdvRows() }])[0];
  const want = { date: 1, dep: 2, arr: 3, route: 4, from: 5, to: 6, checked: 7, ref: 8, company: 9, purpose: 10, tripType: 11, status: 12 };
  for (const k in want) assert.equal(t.cols[k], want[k], k);
  assert.equal(t.cols.inst, undefined);
  assert.equal(t.cols.dir, undefined);
});

test("tider, firma og kansellerte reiser leses riktig", () => {
  const t = C.analyseTables([{ name: "Ark1", rows: mdvRows() }])[0];
  const legs = C.buildLegs(t, t.cols, false);
  assert.equal(legs.length, 13);
  assert.equal(legs[0].dep, "07:30");
  assert.equal(legs[0].arr, "08:00");
  assert.equal(legs[0].company, "Testfirma");
  assert.equal(legs.filter((l) => l.cancelled).length, 1);
});

test("finner landbaser og installasjoner uten retning og navn", () => {
  const t = C.analyseTables([{ name: "Ark1", rows: mdvRows() }])[0];
  const legs = C.buildLegs(t, t.cols, false);
  const k = Object.fromEntries(C.derivePlaces(legs).map((p) => [p.key, p.guess]));
  assert.deepEqual(k, { BASEA: "base", BASEB: "base", I1: "installation", I2: "installation", I3: "installation", I4: "installation", I5: "installation", I6: "installation" });
  const stays = C.buildStays(legs, (x) => k[x]);
  assert.equal(stays.length, 6);
  assert.ok(stays.every((s) => s.days === 14 && s.startKnown && s.endKnown));
});

test("kodeforslag foreslår, men gjetter ikke på tilfeldige navn", () => {
  assert.ok(C.codeScore("SKV", "SKARV") >= 0.5);
  assert.ok(C.codeScore("PJK", "PETROJARL KNARR") >= 0.5);
  assert.equal(C.codeScore("SVG", "SKARV"), 0);
  assert.equal(C.codeScore("X", "XYZ"), 0);
  assert.ok(C.codeScore("SKV", "SKARV") < 0.9, "skal aldri være høy nok til automatisk kobling");
});

test("klokkeslett fra Excel og tekst", () => {
  assert.equal(C.fmtTime(0.3125), "07:30");
  assert.equal(C.fmtTime("07:45:00"), "07:45");
  assert.equal(C.fmtTime(45000), "");
});

test("dato og klokkeslett i samme celle, og innsjekking som klokkeslett", () => {
  const rows = [MDV_HEAD, ["", "05.08.2026", "05.08.2026 11:41", "05.08.2026 12:35", "R1", "INST", "BASE", "09:43", 1, "Testfirma", "Ordinært offshoreopphold", "Reise", ""]];
  const t = C.analyseTables([{ name: "Ark1", rows }])[0];
  const l = C.buildLegs(t, t.cols, false)[0];
  assert.equal(l.date, "2026-08-05");
  assert.equal(l.dep, "11:41");
  assert.equal(l.arr, "12:35");
  assert.equal(l.checked, "09:43");
  assert.equal(l.cancelled, false);
  assert.equal(C.fmtTime(0.40486), "09:43");
});

test("gammelt rigg-navn gir forslag til nytt navn, men ikke på felles merkenavn", () => {
  const names = ["NOBLE INTERCEPTOR", "MAERSK GUARDIAN", "MAERSK GIANT", "NOBLE GUARDIAN", "TRANSOCEAN SPITSBERGEN", "TRANSOCEAN ENDURANCE", "TRANSOCEAN LEADER", "TRANSOCEAN ENCOURAGE", "TRANSOCEAN BARENTS", "OTHER RIG", "ALPHA FIELD", "BRAVO FIELD"];
  const df = C.buildIdf(names);
  assert.ok(C.idfScore("Maersk Interceptor", "NOBLE INTERCEPTOR", df) >= 0.5);
  assert.ok(C.idfScore("Maersk Interceptor", "NOBLE INTERCEPTOR", df) < 0.9, "bare forslag, aldri automatisk");
  assert.equal(C.idfScore("Transocean Arctic", "TRANSOCEAN ENDURANCE", df), 0);   // felles merkenavn er ikke nok
  assert.equal(C.idfScore("Maersk Interceptor", "MAERSK GIANT", df), 0);
});

test("automatisk kobling: boreperioder avgjør mellom rigger med lik kode", () => {
  const act = C.activityByFacility([
    { id: "A", entry: "2023-01-01", comp: "2023-02-10" },
    { id: "A", entry: "2023-03-01", comp: "2023-05-01" }, // 19 dager pause -> én periode
    { id: "B", entry: "2019-01-01", comp: "2019-06-01" },
  ]);
  assert.equal(act.get("A").length, 1);
  const stays = [{ start: "2023-01-10", end: "2023-01-24" }, { start: "2023-04-01", end: "2023-04-15" }];
  assert.equal(C.dateFit(act.get("A"), stays), 1);
  assert.equal(C.dateFit(act.get("B"), stays), 0);
});

test("automatisk kobling velger bare når én kandidat skiller seg ut", () => {
  assert.equal(C.pickAuto([{ sc: 0.8 }, { sc: 0.5 }]).sc, 0.8);
  assert.equal(C.pickAuto([{ sc: 0.8 }, { sc: 0.78 }]), null, "for likt");
  assert.equal(C.pickAuto([{ sc: 0.4 }]), null, "for svakt");
  // like sterke, men på samme felt: posisjonen blir den samme
  assert.equal(C.pickAuto([{ sc: 0.8, lat: 65.7, lon: 7.6 }, { sc: 0.79, lat: 65.71, lon: 7.61 }]).sc, 0.8);
});

test("naboer: installasjoner det er fløyet direkte mellom", () => {
  const kind = (k) => (k === "BASE" ? "base" : "installation");
  const n = C.neighbours([{ from: "BASE", to: "FED" }, { from: "FED", to: "SKV" }, { from: "SKV", to: "FED" }, { from: "FED", to: "BASE" }], kind);
  assert.equal(n.get("FED").get("SKV"), 2);
  assert.equal(n.has("BASE"), false);
});

test("flytid fra heliporten skiller felt med lik kode", () => {
  // 54 min fra Brønnøysund ≈ 180–230 km ut: Norskehavet, ikke Nordsjøen
  const legs = [{ from: "BNN", to: "SKV", dep: "11:41", arr: "12:35" }, { from: "SKV", to: "BNN", dep: "08:00", arr: "08:56" }];
  const hints = C.flightHints(legs, "SKV");
  assert.equal(hints.length, 2);
  assert.equal(C.flightFit([65.72, 7.64], hints), 1, "Skarv passer");
  assert.equal(C.flightFit([58.5, 1.9], hints), -1, "Nordsjøen er for langt unna");
  assert.equal(C.flightFit([65.72, 7.64], C.flightHints([{ from: "XYZ", to: "SKV" }], "SKV")), 0, "ukjent base: ingen vurdering");
  assert.ok(C.heliport("bnn") && C.heliport("ENZV"));
});
