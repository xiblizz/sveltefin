# Jellyfin API notes

Spec: `jellyfin-openapi-stable.json` in the repo root — **version 12.0.0**.
Query it with jq, e.g. `jq -r '.paths | keys[]' jellyfin-openapi-stable.json | grep -i items`.

## Endpoints we use (all server-side, `src/lib/server/jellyfin.js`)

| Purpose | Endpoint |
| --- | --- |
| Login | `POST /Users/AuthenticateByName` (`{Username, Pw}`) |
| Logout | `POST /Sessions/Logout` |
| Libraries (header) | `GET /UserViews?userId=` → filter `CollectionType` movies/tvshows |
| Continue watching | `GET /UserItems/Resume?userId=&mediaTypes=Video` |
| Next up | `GET /Shows/NextUp?userId=` |
| Latest per library | `GET /Items/Latest?parentId=` |
| Browse / search | `GET /Items?parentId=&recursive=true&includeItemTypes=Movie,Series&searchTerm=` |
| Item detail | `GET /Items/{id}?userId=` |
| Items by id (Requested row) | `GET /Items?ids=a,b,c` — response order not guaranteed, reorder in code |
| Seasons / episodes | `GET /Shows/{seriesId}/Seasons`, `GET /Shows/{seriesId}/Episodes?seasonId=` |
| Similar | `GET /Items/{id}/Similar` |
| Playback negotiation | `POST /Items/{id}/PlaybackInfo` (body: `UserId`, `DeviceProfile`) |
| Progress reports | `POST /Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped` |
| Favorites | `POST/DELETE /UserFavoriteItems/{itemId}`; list via `/Items?filters=IsFavorite` |
| Remove from resume | `POST /UserItems/{itemId}/UserData` with `{PlaybackPositionTicks: 0}` |
| Watchlist (playlist) | `GET/POST /Playlists`, `GET/POST/DELETE /Playlists/{id}/Items` (removal needs `entryIds` = each entry's `PlaylistItemId`) |
| Intro/outro markers | `GET /MediaSegments/{itemId}` → filter `Type` Intro/Outro in code (avoids array query-param binding) |
| Active streams widget | `GET /Sessions?activeWithinSeconds=` — Jellyfin scopes results (admins: all, users: own); trimmed to a safe DTO in `/api/streams` |
| Images (proxied) | `GET /Items/{id}/Images/{type}?tag=&maxWidth=&quality=` |
| Video (proxied) | `GET /Videos/{id}/stream[.container]?static=true`, plus runtime `TranscodingUrl` |

## Auth scheme

Everything authenticates with one header:

```
Authorization: MediaBrowser Client="SvelteFin", Device="Web", DeviceId="<stable-hash>", Version="0.1.0", Token="<AccessToken>"
```

`DeviceId` is a SHA-256-derived stable hash of the username (`deviceIdFor()`), so Jellyfin's
dashboard shows one device per user instead of a new one per login.

## v12 gotchas discovered

- **The old dynamic HLS endpoints are gone from the spec** (`/Videos/{id}/main.m3u8`,
  `master.m3u8`, `hls1/...` — no `DynamicHls` tag at all). `MediaSourceInfo.TranscodingUrl`
  still exists, so we treat the transcode URL as an opaque runtime value and whitelist
  `Videos/**` by prefix in the media proxy instead of enumerating endpoints. If transcoded
  playback misbehaves against a real v12 server, inspect what `TranscodingUrl` actually
  returns first.
- User-scoped routes moved off `/Users/{id}/...`: resume is `GET /UserItems/Resume`,
  played-state is `POST|DELETE /UserPlayedItems/{itemId}`, favorites
  `POST|DELETE /UserFavoriteItems/{itemId}` (the latter two not wired up yet).
- `/UserViews` items carry `CollectionType`: `movies`, `tvshows`, `music`, `books`,
  `boxsets`, `playlists`, ... — we only surface the first two.

## Useful item fields

Ask for extra fields explicitly via `fields=` (we default to
`PrimaryImageAspectRatio,ProductionYear,ParentId`). Image tags arrive as
`ImageTags.{Primary,Thumb,...}` and `BackdropImageTags[]`; episodes carry
`SeriesPrimaryImageTag`/`ParentBackdropImageTags` for fallbacks (handled in `src/lib/img.js`).
`UserData` carries `PlaybackPositionTicks`, `PlayedPercentage`, `Played`.
