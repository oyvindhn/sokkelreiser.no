#!/usr/bin/env bash
# Test av api/koder.php mot en midlertidig SQLite-database. Kjøres: bash tests/koder_api.sh
set -u
T=$(mktemp -d); trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/api"; cp static/api/koder.php "$T/api/"
cat > "$T/api/config.php" <<PHP
<?php return ['dsn'=>'sqlite:$T/k.sqlite','salt'=>'test','terskel'=>2,'maks_per_dogn'=>40];
PHP
php -S 127.0.0.1:8799 -t "$T" >/dev/null 2>&1 & PID=$!
sleep 1
U=http://127.0.0.1:8799/api/koder.php
fail=0
ok(){ if [ "$2" = "$3" ]; then echo "ok  $1"; else echo "FEIL $1: fikk '$2', ventet '$3'"; fail=1; fi; }
post(){ curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' ${2:+-H "$2"} --data "$1" $U; }
get(){ curl -s $U; }

ok "tom GET" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo count($j["koder"]);')" 0
ok "gyldig POST" "$(post '{"koder":{"SUP":{"navn":"Floatel Superior"}},"floteller":[{"flotell":"Floatel Superior","felt":"Skarv","maned":"2026-03"}]}')" 200
ok "samme avsender teller én gang" "$(post '{"koder":{"SUP":{"navn":"Floatel Superior"}}}')" 200
ok "under terskel: ikke godkjent" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo count((array)$j["koder"]);')" 0
ok "ugyldig kode avvises" "$(post '{"koder":{"<script>":{"navn":"X"}}}')" 400
ok "ugyldig navn avvises" "$(post '{"koder":{"ABC":{"navn":"a<b>c"}}}')" 400
ok "feil content-type" "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data '{}' $U)" 415
ok "fremmed opphav" "$(post '{"koder":{"ABC":{"navn":"Test"}}}' 'Origin: https://evil.example')" 403
ok "DELETE ikke tillatt" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $U)" 405
ok "for stor body" "$(post "{\"x\":\"$(head -c 21000 /dev/zero | tr '\0' a)\"}")" 413
ok "SQL-injeksjon avvises" "$(post '{"koder":{"ABC\\u0027; DROP TABLE forslag;--":{"navn":"X"}}}')" 400
# annen avsender (annen REMOTE_ADDR): bruk X-header støttes ikke, så simuler med direkte DB-innsetting
php -r '$p=new PDO("sqlite:'$T'/k.sqlite");$p->prepare("INSERT INTO forslag VALUES (?,?,?,?,?,?,?)")->execute([hash("sha256","x"),"k","SUP","FLOATEL SUPERIOR","","annenmelder",time()]);$p->prepare("INSERT INTO forslag VALUES (?,?,?,?,?,?,?)")->execute([hash("sha256","y"),"f","FLOATEL SUPERIOR","SKARV","2026-03","annenmelder",time()]);'
ok "to uavhengige: godkjent" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo $j["koder"]["SUP"]["navn"]," ",$j["koder"]["SUP"]["n"];')" "FLOATEL SUPERIOR 2"
ok "flotell godkjent" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo $j["floteller"][0]["felt"];')" SKARV
php -r '$p=new PDO("sqlite:'$T'/k.sqlite");for($i=0;$i<2;$i++)$p->prepare("INSERT INTO forslag VALUES (?,?,?,?,?,?,?)")->execute([hash("sha256","z$i"),"k","SUP","FLOATEL SUPERIOR X","","m$i",time()]);'
ok "uenighet: ingenting godkjennes" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo isset($j["koder"]["SUP"])?"ja":"nei";')" nei
php -r '$p=new PDO("sqlite:'$T'/k.sqlite");$i=$p->prepare("INSERT INTO forslag VALUES (?,?,?,?,?,?,?)");$i->execute([hash("sha256","q1"),"k","JTN","JOTUN FPSO","","q1",time()]);$i->execute([hash("sha256","q2"),"k","JTN","JOTUN FPSO","2","q2",time()]);'
ok "med og uten sodirId teller som enige" "$(get | php -r '$j=json_decode(stream_get_contents(STDIN),true);echo $j["koder"]["JTN"]["n"]," ",$j["koder"]["JTN"]["sodirId"];')" "2 2"
# rate limit
for i in $(seq 1 50); do post "{\"koder\":{\"R$i\":{\"navn\":\"Rate $i\"}}}" >/dev/null; done
ok "rate limit" "$(post '{"koder":{"RATE":{"navn":"Rate"}}}')" 429
exit $fail
