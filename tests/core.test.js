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

test("feltnavn og Maersk", () => {
  assert.equal(C.titleCase("MÆRSK INSPIRER"), "Maersk Inspirer");
  assert.equal(C.titleCase("IVAR AASEN"), "Ivar Aasen");
  assert.equal(C.titleCase("GOLIAT FPSO"), "Goliat FPSO");
  assert.equal(C.titleCase("PETROJARL KNARR"), "Petrojarl Knarr");
});

/* Sodir: wlbDiscovery er «<brønn> <navn>» (f.eks. «2/4-2 Ekofisk»). Syntetiske eksempler. */
const wbx = (o) => C.normWellbore({ wlbEntryDate: Date.parse("2016-01-01"), wlbCompletionDate: Date.parse("2016-03-01"), wlbNsDecDeg: 59.8, wlbEwDecDeg: 2.6, fclNpdidFacilityDrilling: 5, ...o });

test("riggens navn på datoen", () => {
  const wb = (name, e, c, fac) => wbx({ wlbWellboreName: name, wlbWell: name, wlbEntryDate: Date.parse(e), wlbCompletionDate: Date.parse(c), wlbDrillingFacility: fac });
  const tl = C.rigTimeline("5", [wb("1/1-1", "2016-03-01", "2016-05-20", "OLD NAME"), wb("2/2-1", "2022-01-01", "2022-03-01", "NEW NAME")]);
  assert.equal(C.nameAt(tl, "2016-04-01"), "OLD NAME");
  assert.equal(C.nameAt(tl, "2022-02-01"), "NEW NAME");
});

test("funnnavn fra Sodirs format «brønn navn»", () => {
  assert.equal(C.discoveryName("2/4-2 Ekofisk"), "Ekofisk");
  assert.equal(C.discoveryName("25/2-18 S Langfjellet"), "Langfjellet");
  assert.equal(C.discoveryName("16/1-12 Ivar Aasen"), "Ivar Aasen");
  assert.equal(C.discoveryName("8/5-1"), "", "bare brønnummer er ikke et navn");
  assert.equal(C.discoveryName(""), "");
});

test("lokasjonsnavn: brønn og funnavn, ellers felt, ellers bare brønn", () => {
  const site = (o) => C.rigTimeline("5", [wbx({ wlbWellboreName: "9/9-1 S", wlbWell: "9/9-1", ...o })]).sites[0];
  assert.equal(site({ wlbDiscovery: "9/9-1 Testfunn", wlbField: "TESTFELT" }).name, "9/9-1 Testfunn", "funnavnet (datidens navn) går foran dagens felt");
  assert.equal(site({ wlbField: "TESTFELT" }).name, "9/9-1 Testfelt");
  assert.equal(site({}).name, "9/9-1");
});

test("operatør kortes ned uten å miste identiteten", () => {
  for (const [a, b] of [["Lundin Norway AS", "Lundin"], ["Equinor Energy AS", "Equinor"], ["Phillips Petroleum Company Norway", "Phillips"], ["Aker BP ASA", "Aker BP"], ["A/S Norske Shell", "Norske Shell"], ["LUNDIN NORWAY AS", "Lundin"], ["Premier Oil Norge AS", "Premier Oil"], ["Det norske oljeselskap ASA", "Det Norske"], ["LOTOS Exploration and Production Norge AS", "Lotos"], ["Wintershall Dea Norge AS", "Wintershall Dea"], ["Faroe Petroleum Norge AS", "Faroe Petroleum"], ["FAROE PETROLEUM NORGE AS", "Faroe Petroleum"]])
    assert.equal(C.shortOperator(a), b, a);
});


test("alias og pressemelding hentes fra Sodir, men brukes ikke som navn", () => {
  const w = (o) => C.normWellbore({ wlbWellboreName: "9/9-1", wlbWell: "9/9-1", wlbEntryDate: Date.parse("2016-01-01"), wlbCompletionDate: Date.parse("2016-03-01"), wlbNsDecDeg: 59.8, wlbEwDecDeg: 2.6, fclNpdidFacilityDrilling: 5, ...o });
  const a = C.rigTimeline("5", [w({ wlbAliasName: "Testprospekt", wlbPressReleaseUrl: "https://example.org/pm" })]).sites[0];
  assert.deepEqual(a.aliases, ["Testprospekt"]);
  assert.equal(a.press, "https://example.org/pm");
  assert.equal(a.name, "9/9-1", "alias endrer ikke navnet");
  const b = C.rigTimeline("5", [w({ wlbAliasName: "9/9-1 S", wlbPressReleaseUrl: " " })]).sites[0];
  assert.deepEqual(b.aliases, [], "brønnbetegnelser er ikke alias");
  assert.equal(b.press, "");
});

test("prospektnavn fra brønnhistorikk: bare tydelige formuleringer", () => {
  const n = (t) => (C.prospectFromHistory(t) || {}).name || null;
  assert.equal(n("Wildcat well 9/9-1 was drilled to test the Testby prospect in the Central Graben."), "Testby");
  assert.equal(n("The prospect named Eksempel was tested."), "Eksempel");
  assert.equal(n("Brønnen ble boret på Prøve-prospektet i Nordsjøen."), "Prøve");
  assert.equal(n("The well tested the Ivar Test prospect."), "Ivar Test");
  assert.equal(n("The well was drilled on the Upper Jurassic prospect."), null, "geologi er ikke et navn");
  assert.equal(n("The main objective was to prove petroleum in the Brent Group."), null);
  assert.equal(n(""), null);
  // slik Sodir faktisk skriver det: stor P og HTML rundt
  assert.equal(n("<p><b>General</b></p><p>The 2/8-18 S well was drilled on the Clapton Prospect in the Feda Graben.</p>"), "Clapton");
  assert.equal(n("Wildcat well 9/9-2 was drilled to test the Myrhauk Prospect&nbsp;in the North Sea."), "Myrhauk");
  assert.equal(n("The Prospect was dry."), null, "«The Prospect» alene er ikke et navn");
});

test("lokasjonsnavn: prospekt fra historikken går foran funn og felt", () => {
  const s = C.rigTimeline("5", [C.normWellbore({ wlbWellboreName: "9/9-1", wlbWell: "9/9-1", wlbEntryDate: Date.parse("2016-01-01"), wlbCompletionDate: Date.parse("2016-03-01"), wlbNsDecDeg: 59.8, wlbEwDecDeg: 2.6, wlbField: "TESTFELT", fclNpdidFacilityDrilling: 5, wlbNpdidWellbore: 123 })]).sites[0];
  assert.equal(s.name, "9/9-1 Testfelt");
  assert.equal(s.wells[0].npdid, "123");
  s.prospect = "Testby"; C.nameSite(s);
  assert.equal(s.name, "9/9-1 Testby");
});

test("hjemreise fra en annen installasjon (gangbro) hører til samme opphold", () => {
  const k = { SVG: "base", BNN: "base", SKV: "installation", FED: "installation" };
  const legs = [
    { i: 1, date: "2026-03-11", from: "BNN", to: "SKV" },
    { i: 0, date: "2026-03-27", from: "FED", to: "BNN" },
  ];
  const s = C.buildStays(legs, (x) => k[x]);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, "SKV");
  assert.equal(s[0].days, 16);
  assert.ok(s[0].endKnown);
  assert.equal(s[0].homeFrom, "FED");
});

test("SVG–SVG (helikopteret snudde) vises, uten overnatting, og ny utreise samme dag teller", () => {
  const k = { SVG: "base", SLA: "installation" };
  const legs = [
    { i: 2, date: "2026-02-01", from: "SVG", to: "SVG", dep: "07:30" },
    { i: 1, date: "2026-02-01", from: "SVG", to: "SLA", dep: "13:10" },
    { i: 0, date: "2026-02-15", from: "SLA", to: "SVG", dep: "12:00" },
  ];
  const s = C.buildStays(legs, (x) => k[x]);
  assert.equal(s.length, 2);
  assert.ok(s[0].turnback);
  assert.equal(s[0].days, 0);
  assert.equal(s[1].key, "SLA");
  assert.equal(s[1].days, 14);
});

test("samme dag uten tider: arket nyeste først snus riktig", () => {
  const t = { body: [
    ["15.02.2026", "", "", "", "SLA", "SVG"],
    ["01.02.2026", "", "", "", "SVG", "SLA"],
    ["01.02.2026", "", "", "", "SVG", "SVG"],
  ] };
  const legs = C.buildLegs(t, { date: 0, from: 4, to: 5 }, false);
  assert.deepEqual(legs.map((l) => l.from + l.to), ["SVGSVG", "SVGSLA", "SLASVG"]);
});

test("heliportens rekkevidde: BNN flyr til Skarv, ikke til Castberg", () => {
  const skarv = [65.7, 7.6], castberg = [71.6, 20.4], sverdrup = [58.85, 2.6];
  assert.equal(C.reachable("BNN", skarv), true);
  assert.equal(C.reachable("BNN", castberg), false);
  assert.equal(C.reachable("HFT", castberg), true);
  assert.equal(C.reachable("ENBN", skarv), true);
  assert.equal(C.reachable("BNN", sverdrup), false);
  assert.equal(C.reachable("SVG", sverdrup), true);
  assert.equal(C.reachable("ABC", skarv), null);
});

test("flotellperioder: åpne perioder varer til neste oppdrag", () => {
  const E = [
    { felt: "SKARV", fra: "2024-02-12" },
    { felt: "BALDER", til: "2025-06-24" },
    { felt: "WHITE ROSE", utland: true, fra: "2025-07-08", til: "2026-01-06" },
    { felt: "SKARV", fra: "2026-03-14" },
  ];
  const P = C.flotelPeriods(E);
  assert.equal(P[0].to, "2025-06-24");
  assert.equal(P[1].from, "2024-02-12");
  const at = (d) => C.flotelCandidates(E, d, [], () => [60, 3]).map((e) => e.felt);
  assert.deepEqual(at("2024-06-01"), ["SKARV", "BALDER"]);
  assert.deepEqual(at("2025-09-01"), []);            // i Canada
  assert.deepEqual(at("2026-03-20"), ["SKARV"]);
  // fløy fra BNN: Balder (Nordsjøen) er umulig
  const pos = (e) => (e.felt === "SKARV" ? [65.7, 7.6] : [59.25, 2.37]);
  assert.deepEqual(C.flotelCandidates(E, "2024-06-01", ["BNN"], pos).map((e) => e.felt), ["SKARV"]);
});

test("fartøy uten rigg- eller boligfunksjon er ikke mulige reisemål", () => {
  assert.equal(C.isFlyable({ moveable: false, kind: "FIXED JACKET", functions: "" }), true);
  assert.equal(C.isFlyable({ moveable: true, kind: "SEMISUB STEEL", functions: "DRILLING" }), true);
  assert.equal(C.isFlyable({ moveable: true, kind: "SEMISUB STEEL", functions: "ACCOMMODATION" }), true);
  assert.equal(C.isFlyable({ moveable: true, kind: "VESSEL", functions: "ACCOMMODATION" }), true);
  assert.equal(C.isFlyable({ moveable: true, kind: "VESSEL", functions: "SUPPORT" }), false);
  assert.equal(C.isFlyable({ moveable: true, kind: "VESSEL", functions: "" }), false);
});

test("titleCase: plattformkoder uten vokal i store bokstaver", () => {
  assert.equal(C.titleCase("VALHALL PH"), "Valhall PH");
  assert.equal(C.titleCase("EKOFISK 2/4 QP"), "Ekofisk 2/4 QP");
  assert.equal(C.titleCase("GULLFAKS A"), "Gullfaks A");
  assert.equal(C.titleCase("DRAUPNER S"), "Draupner S");
  assert.equal(C.titleCase("MÆRSK GUARDIAN"), "Maersk Guardian");
  assert.equal(C.titleCase("TROLL B"), "Troll B");
});

test("nameHistory gir navnene i rekkefølge", () => {
  const w=(f,a,b)=>({facility:f,entry:a,comp:b});
  const tl={visits:[{wells:[w("MAERSK X","2010-01-01","2010-03-01"),w("MAERSK X","2011-01-01","2011-02-01")]},{wells:[w("NOBLE X","2016-01-01","2016-02-01")]}]};
  const h=C.nameHistory(tl);
  assert.deepEqual(h.map(x=>x.name),["MAERSK X","NOBLE X"]);
  assert.equal(h[0].to,"2011-02-01");assert.equal(h[1].from,"2016-01-01");
  assert.deepEqual(C.nameHistory(null),[]);
});

test("registryName gir datidens navn fra riggregisteret", () => {
  const reg=[[{navn:"Maersk Interceptor",til:"2022-10-02"},{navn:"Noble Interceptor",fra:"2022-10-03"}]];
  assert.equal(C.registryName(reg,"MAERSK INTERCEPTOR","2018-05-01").navn,"Maersk Interceptor");
  assert.equal(C.registryName(reg,"Noble Interceptor","2018-05-01").navn,"Maersk Interceptor");
  assert.equal(C.registryName(reg,"Noble Interceptor","2023-01-01").navn,"Noble Interceptor");
  assert.equal(C.registryName(reg,"Ukjent rigg","2023-01-01"),null);
});

test("innretningshistorikk gir navn og datoer", () => {
  const rows=[{name:"MÆRSK INSPIRER",from:"2007-01-18",to:"2021-10-31"},{name:"MÆRSK INSPIRER",from:"2021-10-01",to:"2021-10-31"},{name:"INSPIRER",from:"2021-11-01",to:""}];
  assert.equal(C.histRowAt(rows,"2013-09-12").name,"MÆRSK INSPIRER");
  assert.equal(C.histRowAt(rows,"2022-01-01").name,"INSPIRER");
  assert.equal(C.histRowAt(rows,"2005-01-01"),null);
  assert.deepEqual(C.histNames(rows).map(n=>n.name),["MÆRSK INSPIRER","INSPIRER"]);
});

/* ---------- høytider og merker ---------- */
test("påskedag", () => {
  assert.equal(C.easterSunday(2024), "2024-03-31");
  assert.equal(C.easterSunday(2025), "2025-04-20");
  assert.equal(C.easterSunday(2026), "2026-04-05");
});
test("høytider offshore: utreise teller, hjemreise samme dag teller ikke", () => {
  const st = [
    { key: "A", start: "2023-12-20", end: "2024-01-03", days: 14, segs: [] },  // jul + nyttår 2023
    { key: "B", start: "2024-12-24", end: "2025-01-07", days: 14, segs: [] },  // ut julaften: teller
    { key: "C", start: "2025-12-10", end: "2025-12-24", days: 14, segs: [] },  // hjem julaften: teller ikke
    { key: "D", start: "2025-05-10", end: "2025-05-24", days: 14, segs: [] },  // 17. mai
    { key: "E", start: "2025-04-15", end: "2025-04-29", days: 14, segs: [] },  // påske 2025 (20.4)
  ];
  const h = Object.fromEntries(C.holidaysOffshore(st).map(x => [x.id, x.hits.map(y => y.year)]));
  assert.deepEqual(h.jul, [2023, 2024]);
  assert.deepEqual(h.nyttar, [2023, 2024]);
  assert.deepEqual(h.mai17, [2025]);
  assert.deepEqual(h.paske, [2025]);
  assert.equal(h.sankthans, undefined, "sankthans er ikke med");
});
test("merker: terskler, hav og fremdrift", () => {
  const site = (lat, kind = "fixed", facilityId = "") => ({ lat, lon: 3, kind, facilityId });
  const st = [];
  for (let i = 0; i < 8; i++) st.push({ key: "K" + (i % 6), start: `202${i % 4}-0${1 + (i % 8)}-01`, end: `202${i % 4}-0${1 + (i % 8)}-15`, days: 14, segs: [{ site: site(i < 6 ? 58 : 66.8) }] });
  st.push({ key: "K0", start: "2023-10-01", end: "2023-10-22", days: 21, segs: [{ site: site(71.3) }] });
  st.push({ key: "K0", start: "2023-11-01", end: "2023-11-01", turnback: true, segs: [] });
  const legs = st.flatMap(s => [{ date: s.start, from: "SVG", to: s.key }, { date: s.end, from: s.key, to: "SVG" }]);
  const b = Object.fromEntries(C.badges({ stays: st, legs }).map(x => [x.id, x]));
  assert.ok(b.d100.date, "100 døgn");
  assert.equal(b.d500.date, null);
  assert.equal(b.d500.have, 133);
  assert.ok(b["s-alle"].date && b.polar.date && b.snudd.date && b.i5.date && b.t1.date);
  assert.equal(b.lang, undefined);
  assert.equal(b.i10.date, null);
  assert.equal(b.f50.date, null);
  assert.equal(b.f50.have, 20);
  // trappetrinn: bare neste trinn i hver serie vises, resten telles som skjulte
  const { shown, hidden } = C.visibleBadges(Object.values(b));
  const ids = shown.map(x => x.id);
  assert.ok(ids.includes("d100") && ids.includes("d365") && !ids.includes("d500") && !ids.includes("d1000") && !ids.includes("d5000"));
  assert.ok(ids.includes("f50") && !ids.includes("f100"));
  assert.ok(ids.includes("y5") && !ids.includes("y10") && !ids.includes("y30") && !ids.includes("y40"));
  assert.ok(ids.includes("i10") && ids.includes("i5"));
  assert.ok(ids.includes("s100") && !ids.includes("s500"));
  assert.equal(hidden, 4 + 4 + 4 + 1);
});
test("hemmelige merker vises ikke før de er oppnådd", () => {
  const st = [{ key: "K", start: "2024-01-01", end: "2024-01-15", days: 14, segs: [{ site: { lat: 58 } }] }];
  const all = C.badges({ stays: st, legs: [] });
  const v = C.visibleBadges(all);
  assert.ok(!v.shown.some(x => x.id === "snudd"));
  assert.ok(v.hidden >= 1);
});
