<?php
/* Sokkelreiser: felles kodeliste. Bare koder og flotellplasseringer. Ingen reiser, datoer, brukere eller innlogging.
   GET  -> godkjente koder (samme forslag fra flere uavhengige avsendere). POST -> nye forslag. Ingenting overskrives eller slettes. */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');

function svar(int $kode, array $data): never { http_response_code($kode); echo json_encode($data, JSON_UNESCAPED_UNICODE); exit; }

$cfgFil = __DIR__ . '/config.php';
if (!is_file($cfgFil)) svar(503, ['feil' => 'ikke konfigurert']);
$cfg = require $cfgFil;
$salt = (string)($cfg['salt'] ?? '');
if ($salt === '' || empty($cfg['dsn'])) svar(503, ['feil' => 'ikke konfigurert']);
$terskel = max(1, (int)($cfg['terskel'] ?? 3));
$maksPerDogn = max(10, (int)($cfg['maks_per_dogn'] ?? 300));

$metode = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($metode !== 'GET' && $metode !== 'POST') svar(405, ['feil' => 'metode ikke tillatt']);

try {
    $pdo = new PDO((string)$cfg['dsn'], $cfg['bruker'] ?? null, $cfg['passord'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $mysql = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql';
    $pdo->exec('CREATE TABLE IF NOT EXISTS forslag (
        nokkel CHAR(64) NOT NULL PRIMARY KEY,
        type CHAR(1) NOT NULL,
        a VARCHAR(80) NOT NULL,
        b VARCHAR(80) NOT NULL,
        c VARCHAR(200) NOT NULL,
        melder CHAR(64) NOT NULL,
        tid INT NOT NULL
    )' . ($mysql ? ' DEFAULT CHARSET=utf8mb4' : ''));
    if ($metode === 'GET') hent($pdo, $terskel);
    motta($pdo, $mysql, $salt, $maksPerDogn);
} catch (Throwable $e) {
    error_log('koder.php: ' . $e->getMessage());
    svar(500, ['feil' => 'serverfeil']);
}

/* ---------- GET ---------- */
function hent(PDO $pdo, int $terskel): never {
    $kode = [];
    // forslag er enige når kode og navn er like; Sodir-id/«ligger ved» hentes fra varianten flest har sendt
    $samlet = [];
    foreach ($pdo->query("SELECT a, b, c, COUNT(*) AS n FROM forslag WHERE type = 'k' GROUP BY a, b, c") as $r) {
        $m = &$samlet[$r['a'] . "\0" . $r['b']];
        $m['n'] = ($m['n'] ?? 0) + (int)$r['n'];
        if (!isset($m['cn']) || (int)$r['n'] > $m['cn'] || ($m['c'] === '' && $r['c'] !== '' && (int)$r['n'] >= $m['cn'])) { $m['c'] = $r['c']; $m['cn'] = (int)$r['n']; }
        $m['a'] = $r['a']; $m['b'] = $r['b'];
        unset($m);
    }
    foreach ($samlet as $m) $kode[$m['a']][] = ['navn' => $m['b'], 'c' => $m['c'], 'n' => $m['n']];
    $ut = [];
    foreach ($kode as $k => $liste) {
        usort($liste, fn($x, $y) => $y['n'] <=> $x['n']);
        $topp = $liste[0];
        if ($topp['n'] < $terskel) continue;
        if (isset($liste[1]) && $liste[1]['n'] >= $topp['n']) continue;   // uenighet: ingenting godkjennes
        $e = ['navn' => $topp['navn'], 'n' => $topp['n']];
        if (str_starts_with($topp['c'], 'v:')) { $v = json_decode(substr($topp['c'], 2), true); if ($v) $e['ved'] = $v; }
        elseif ($topp['c'] !== '') $e['sodirId'] = $topp['c'];
        $ut[$k] = $e;
    }
    $flot = [];
    foreach ($pdo->query("SELECT a, b, c, COUNT(*) AS n FROM forslag WHERE type = 'f' GROUP BY a, b, c HAVING COUNT(*) >= " . $terskel) as $r) {
        $flot[] = ['flotell' => $r['a'], 'felt' => $r['b'], 'maned' => $r['c'], 'n' => (int)$r['n']];
    }
    svar(200, ['app' => 'sokkelreiser', 'version' => 1, 'terskel' => $terskel, 'koder' => (object)$ut, 'floteller' => $flot]);
}

/* ---------- POST ---------- */
function rens(mixed $s, int $maks): ?string {
    if (!is_string($s)) return null;
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    if ($s === '' || mb_strlen($s) > $maks) return null;
    return mb_strtoupper($s);
}
function navnOk(?string $s): bool { return $s !== null && mb_strlen($s) >= 2 && preg_match('/^[\p{L}\p{N} .\/&\-]+$/u', $s) === 1; }
function kodeOk(?string $s): bool { return $s !== null && preg_match('/^[A-Z0-9ÆØÅ]{2,6}$/u', $s) === 1; }
function datoOk(mixed $d): bool { return $d === '' || (is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) === 1); }

function motta(PDO $pdo, bool $mysql, string $salt, int $maksPerDogn): never {
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if (isset($_SERVER['HTTP_ORIGIN'])) {
        $oh = parse_url((string)$_SERVER['HTTP_ORIGIN'], PHP_URL_HOST);
        if (!$oh || strcasecmp($oh, preg_replace('/:\d+$/', '', $host)) !== 0) svar(403, ['feil' => 'ugyldig opphav']);
    }
    if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) svar(415, ['feil' => 'bare JSON']);
    $raa = file_get_contents('php://input', false, null, 0, 20001);
    if ($raa === false || $raa === '' || strlen($raa) > 20000) svar(413, ['feil' => 'for stor eller tom']);
    $j = json_decode($raa, true);
    if (!is_array($j)) svar(400, ['feil' => 'ugyldig JSON']);

    $rader = [];
    foreach ((is_array($j['koder'] ?? null) ? $j['koder'] : []) as $k => $e) {
        $kode = rens((string)$k, 6); $navn = is_array($e) ? rens($e['navn'] ?? null, 80) : null;
        if (!kodeOk($kode) || !navnOk($navn)) continue;
        $c = '';
        if (isset($e['ved'])) {
            $ved = is_array($e['ved']) ? $e['ved'] : [['ved' => $e['ved']]];
            $ok = [];
            foreach (array_slice($ved, 0, 4) as $v) {
                if (is_string($v)) $v = ['ved' => $v];
                $vk = is_array($v) ? rens($v['ved'] ?? null, 6) : null;
                $fra = $v['fra'] ?? ''; $til = $v['til'] ?? '';
                if (!kodeOk($vk) || !datoOk($fra) || !datoOk($til)) { $ok = []; break; }
                $ok[] = array_filter(['ved' => $vk, 'fra' => $fra, 'til' => $til], fn($x) => $x !== '');
            }
            if (!$ok) continue;
            $c = 'v:' . json_encode($ok, JSON_UNESCAPED_UNICODE);
        } elseif (isset($e['sodirId'])) {
            $id = (string)$e['sodirId'];
            if (preg_match('/^\d{1,12}$/', $id) !== 1) continue;
            $c = $id;
        }
        if (strlen($c) > 200) continue;
        $rader[] = ['k', $kode, $navn, $c];
    }
    foreach ((is_array($j['floteller'] ?? null) ? $j['floteller'] : []) as $f) {
        if (!is_array($f)) continue;
        $fl = rens($f['flotell'] ?? null, 80); $felt = rens($f['felt'] ?? null, 80); $m = $f['maned'] ?? '';
        if (!navnOk($fl) || !navnOk($felt) || !is_string($m) || preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $m) !== 1) continue;
        $rader[] = ['f', $fl, $felt, $m];
    }
    $rader = array_slice($rader, 0, 80);
    if (!$rader) svar(400, ['feil' => 'ingenting gyldig å lagre']);

    // avsender: saltet hash av IP, bare for å telle uavhengige forslag og begrense misbruk
    $melder = hash('sha256', $salt . '|' . ($_SERVER['REMOTE_ADDR'] ?? ''));
    $st = $pdo->prepare('SELECT COUNT(*) FROM forslag WHERE melder = ? AND tid > ?');
    $st->execute([$melder, time() - 86400]);
    if ((int)$st->fetchColumn() + count($rader) > $maksPerDogn) svar(429, ['feil' => 'for mange forslag i dag']);

    $sql = ($mysql ? 'INSERT IGNORE' : 'INSERT OR IGNORE') . ' INTO forslag (nokkel, type, a, b, c, melder, tid) VALUES (?,?,?,?,?,?,?)';
    $ins = $pdo->prepare($sql); $nye = 0;
    foreach ($rader as [$t, $a, $b, $c]) {
        $ins->execute([hash('sha256', "$t|$a|$b|$c|$melder"), $t, $a, $b, $c, $melder, time()]);
        $nye += $ins->rowCount();
    }
    svar(200, ['mottatt' => count($rader), 'nye' => $nye]);
}
