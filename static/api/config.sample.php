<?php
/* Kopier til config.php PÅ SERVEREN og fyll ut. config.php skal aldri ligge i git (rsync overskriver den ikke). */
return [
    // MySQL/MariaDB:
    'dsn'      => 'mysql:host=localhost;dbname=DATABASENAVN;charset=utf8mb4',
    'bruker'   => 'DATABASEBRUKER',
    'passord'  => 'DATABASEPASSORD',
    // SQLite (alternativ, uten egen databaseserver; filen må ligge utenfor offentlig mappe eller være beskyttet):
    // 'dsn' => 'sqlite:/full/sti/til/koder.sqlite',
    'salt'     => 'BYTT-MEG-lang-tilfeldig-streng',   // brukes til å hashe avsenderens IP
    'terskel'  => 3,                                    // antall uavhengige forslag som må være enige
    'maks_per_dogn' => 300,                             // maks forslag per avsender per døgn
];
