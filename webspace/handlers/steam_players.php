<?php
declare(strict_types=1);

const NICON_STEAM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function nicon_steam_get(string $path, array $params): array
{
    $url = 'https://api.steampowered.com' . $path . '?' . http_build_query($params);
    $ch = curl_init($url);
    $body = '';
    $tooLarge = false;
    curl_setopt_array($ch, [
        CURLOPT_TIMEOUT => 12,
        CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$tooLarge): int {
            if (strlen($body) + strlen($chunk) > NICON_STEAM_MAX_RESPONSE_BYTES) {
                $tooLarge = true;
                return -1;
            }
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($tooLarge || $ok === false || $status < 200 || $status >= 300) {
        throw new RuntimeException('Steam Web API request failed');
    }
    $data = json_decode($body, true);
    if (!is_array($data)) throw new RuntimeException('Steam Web API returned invalid JSON');
    return $data;
}

function nicon_steam_public_url(string $url, array $allowedHosts): string
{
    if (filter_var($url, FILTER_VALIDATE_URL) === false) return '';
    $parts = parse_url($url);
    $host = strtolower((string) ($parts['host'] ?? ''));
    return ($parts['scheme'] ?? '') === 'https' && in_array($host, $allowedHosts, true) ? $url : '';
}

function nicon_handle_steam_players(int $userId): void
{
    if (!nicon_rate_limit_allow("steam-players:$userId", 30, 60)) {
        nicon_send_error('too many Steam lookups', 429);
        return;
    }
    $key = (string) (nicon_config()['steam_api_key'] ?? '');
    if ($key === '') {
        nicon_send_error('Steam integration is not configured', 503);
        return;
    }
    $ids = nicon_json_body()['steamids'] ?? [];
    if (!is_array($ids)) {
        nicon_send_error('steamids must be an array', 400);
        return;
    }
    $ids = array_values(array_unique(array_filter(array_map('strval', $ids), static fn(string $id): bool => preg_match('/^7656119\d{10}$/', $id) === 1)));
    if (!$ids || count($ids) > 100) {
        nicon_send_error('provide between 1 and 100 valid SteamID64 values', 400);
        return;
    }
    $joined = implode(',', $ids);
    try {
        $summaries = nicon_steam_get('/ISteamUser/GetPlayerSummaries/v2/', ['key' => $key, 'steamids' => $joined]);
        $bans = nicon_steam_get('/ISteamUser/GetPlayerBans/v1/', ['key' => $key, 'steamids' => $joined]);
    } catch (RuntimeException $e) {
        nicon_send_error($e->getMessage(), 502);
        return;
    }
    $profiles = [];
    foreach (($summaries['response']['players'] ?? []) as $player) {
        $id = (string) ($player['steamid'] ?? '');
        if ($id === '') continue;
        $profiles[$id] = [
            'steamid' => $id,
            'name' => (string) ($player['personaname'] ?? ''),
            'profile_url' => nicon_steam_public_url((string) ($player['profileurl'] ?? ''), ['steamcommunity.com', 'www.steamcommunity.com']),
            'created_at' => isset($player['timecreated']) ? (int) $player['timecreated'] : null,
        ];
    }
    foreach (($bans['players'] ?? []) as $ban) {
        $id = (string) ($ban['SteamId'] ?? '');
        if ($id === '') continue;
        if (!isset($profiles[$id])) $profiles[$id] = ['steamid' => $id];
        $profiles[$id]['vac_banned'] = (bool) ($ban['VACBanned'] ?? false);
        $profiles[$id]['vac_bans'] = (int) ($ban['NumberOfVACBans'] ?? 0);
        $profiles[$id]['game_bans'] = (int) ($ban['NumberOfGameBans'] ?? 0);
        $profiles[$id]['community_banned'] = (bool) ($ban['CommunityBanned'] ?? false);
        $profiles[$id]['days_since_last_ban'] = (int) ($ban['DaysSinceLastBan'] ?? 0);
    }
    nicon_send_json(['players' => array_values($profiles)]);
}
