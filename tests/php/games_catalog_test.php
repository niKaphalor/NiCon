<?php
// The API's view of the game catalog (lib/games_catalog.php, generated from
// data/games.json): which games may be stored, and how Nitrado's names map on.
// Run: php tests/php/games_catalog_test.php

$root = dirname(__DIR__, 2) . '/webspace';
require_once $root . '/lib/games_catalog.php';
require_once $root . '/handlers/servers.php';
require_once $root . '/handlers/nitrado_sync.php';

$failures = 0;
function check(bool $ok, string $what): void
{
    global $failures;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL: $what\n");
    }
}

// Every catalog game is allowed, a generic console too, anything else is not.
foreach (NICON_GAME_CATALOG as [$label]) {
    check(nicon_game_is_allowed($label), "$label is allowed");
}
check(nicon_game_is_allowed(''), 'generic console is allowed');
check(!nicon_game_is_allowed('Not A Game'), 'unknown game is rejected');
check(!nicon_game_is_allowed('rust'), 'labels are matched exactly');

// Nitrado name -> game and protocol; the longest alias wins.
$cases = [
    'Rust' => ['Rust', 'webrcon'],
    'Minecraft Vanilla' => ['Minecraft', 'source'],
    '7 Days to Die' => ['7 Days to Die', 'telnet'],
    'Hell Let Loose: Vietnam' => ['Hell Let Loose: Vietnam', 'source'],
    'Hell Let Loose' => ['Hell Let Loose', 'source'],
    'Squad 44' => ['Squad 44', 'source'],
    'Squad' => ['Squad', 'source'],
    'Arma Reforger' => ['Arma Reforger', 'battleye'],
    'Palworld' => ['Palworld', 'palworld_rest'],
    'Game 83 Edition' => ['83', 'source'],
];
foreach ($cases as $nitrado => [$name, $protocol]) {
    $got = nicon_supported_game($nitrado);
    check($got !== null && $got['name'] === $name && $got['protocol'] === $protocol, "Nitrado '$nitrado' maps to $name/$protocol, got " . json_encode($got));
}
check(nicon_supported_game('Some Unlisted Game') === null, 'unlisted Nitrado game is not supported');
check(nicon_supported_game('Server 1830') === null, '83 only matches as a whole number');

if ($failures > 0) {
    exit(1);
}
echo "games catalog: ok\n";
