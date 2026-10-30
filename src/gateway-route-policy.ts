/**
 * Auditable household relay policy. Member subset of path templates from Jellyfin 10.11.11 and 12.4.0 OpenAPI:
 * https://repo.jellyfin.org/files/openapi/stable/jellyfin-openapi-10.11.11.json
 * https://repo.jellyfin.org/files/openapi/jellyfin-openapi-stable.json (12.4.0, retrieved 2026-10-30).
 * Route membership never overrides gateway refusals, membership checks or item/user scoping.
 * Elevated methods are refused here, including on paths shared with member reads.
 * {name} matches one segment, {*asset} only static asset descendants. Input MUST be the gateway's canonical route.
 */
export const HOUSEHOLD_RELAY_ROUTES: readonly string[] = [
  // Jellyfin web entry page, including a slash that canonicalisation removes.
  "/web",
  // Legacy per-user configuration update.
  "/users/{user}/configuration",
  // Legacy per-user password update.
  "/users/{user}/password",
  // Legacy per-user PIN update.
  "/users/{user}/easypassword",
  // Legacy household library views used by Jellyfin clients.
  "/users/{user}/views",
  // Legacy library view grouping options.
  "/users/{user}/groupingoptions",
  // Legacy item listing with the user checked against the caller.
  "/users/{user}/items",
  // Legacy resume list.
  "/users/{user}/items/resume",
  // Legacy latest-media list.
  "/users/{user}/items/latest",
  // Legacy root library item.
  "/users/{user}/items/root",
  // Legacy media suggestions.
  "/users/{user}/suggestions",
  // Legacy item details; gateway checks user and item visibility.
  "/users/{user}/items/{item}",
  // Legacy watched-state update; gateway checks user and item.
  "/users/{user}/playeditems/{item}",
  // Legacy member item details/state; gateway checks both user and item.
  "/users/{user}/items/{item}/specialfeatures",
  // Legacy member item details/state; gateway checks both user and item.
  "/users/{user}/items/{item}/localtrailers",
  // Legacy member item details/state; gateway checks both user and item.
  "/users/{user}/items/{item}/intros",
  // Legacy member item details/state; gateway checks both user and item.
  "/users/{user}/items/{item}/rating",
  // Legacy member item details/state; gateway checks both user and item.
  "/users/{user}/items/{item}/userdata",
  // Legacy playback start and stop; gateway checks user and item.
  "/users/{user}/playingitems/{item}",
  // Legacy playback progress; gateway checks user and item.
  "/users/{user}/playingitems/{item}/progress",
  // Legacy favorite-state update; gateway checks user and item.
  "/users/{user}/favoriteitems/{item}",
  // Legacy profile image used without a token by the household picker.
  "/users/{user}/images/{type}",
  // Legacy indexed profile image; household member images only.
  "/users/{user}/images/{type}/{index}",

  // Jellyfin web entry redirect.
  "/",
  // Creates an instant playlist based on a given album.
  "/albums/{itemid}/instantmix",
  // Gets similar items.
  "/albums/{itemid}/similar",
  // Gets all artists from a given item, folder, or the entire library.
  "/artists",
  // Gets all album artists from a given item, folder, or the entire library.
  "/artists/albumartists",
  // Creates an instant playlist based on a given artist.
  "/artists/instantmix",
  // Creates an instant playlist based on a given artist.
  "/artists/{itemid}/instantmix",
  // Gets similar items.
  "/artists/{itemid}/similar",
  // Gets an artist by name.
  "/artists/{name}",
  // Get artist image by name.
  "/artists/{name}/images/{imagetype}/{imageindex}",
  // Gets the specified audio segment for an audio item.
  "/audio/{itemid}/hls/{segmentid}/stream.aac",
  // Gets the specified audio segment for an audio item.
  "/audio/{itemid}/hls/{segmentid}/stream.mp3",
  // Gets a video stream using HTTP live streaming.
  "/audio/{itemid}/hls1/{playlistid}/{segmentid}.{container}",
  // Gets an item's lyrics.
  "/audio/{itemid}/lyrics",
  // Gets an audio stream using HTTP live streaming.
  "/audio/{itemid}/main.m3u8",
  // Gets an audio hls playlist stream.
  "/audio/{itemid}/master.m3u8",
  // Search remote lyrics.
  "/audio/{itemid}/remotesearch/lyrics",
  // Downloads a remote lyric.
  "/audio/{itemid}/remotesearch/lyrics/{lyricid}",
  // Gets an audio stream.
  "/audio/{itemid}/stream",
  // Gets an audio stream.
  "/audio/{itemid}/stream.{container}",
  // Gets an audio stream.
  "/audio/{itemid}/universal",
  // Gets branding configuration.
  "/branding/configuration",
  // Gets branding css.
  "/branding/css",
  // Gets branding css.
  "/branding/css.css",
  // Generates or gets the splashscreen.
  "/branding/splashscreen",
  // Gets available channels.
  "/channels",
  // Get all channel features.
  "/channels/features",
  // Gets latest channel items.
  "/channels/items/latest",
  // Get channel features.
  "/channels/{channelid}/features",
  // Get channel items.
  "/channels/{channelid}/items",
  // Upload a document.
  "/clientlog/document",
  // Creates a new collection.
  "/collections",
  // Adds items to a collection.
  "/collections/{collectionid}/items",
  // Get Display Preferences.
  "/displaypreferences/{displaypreferencesid}",
  // Gets a list of available fallback font files.
  "/fallbackfont/fonts",
  // Gets a fallback font file.
  "/fallbackfont/fonts/{name}",
  // Gets all genres from a given item, folder, or the entire library.
  "/genres",
  // Gets a genre, by name.
  "/genres/{genrename}",
  // Get genre image by name.
  "/genres/{name}/images/{imagetype}",
  // Get genre image by name.
  "/genres/{name}/images/{imagetype}/{imageindex}",
  // Gets the current UTC time.
  "/getutctime",
  // Gets items based on a query.
  "/items",
  // Get item counts.
  "/items/counts",
  // Gets legacy query filters.
  "/items/filters",
  // Gets query filters.
  "/items/filters2",
  // Gets latest media.
  "/items/latest",
  // Get book remote search.
  "/items/remotesearch/book",
  // Get box set remote search.
  "/items/remotesearch/boxset",
  // Get movie remote search.
  "/items/remotesearch/movie",
  // Get music album remote search.
  "/items/remotesearch/musicalbum",
  // Get music artist remote search.
  "/items/remotesearch/musicartist",
  // Get music video remote search.
  "/items/remotesearch/musicvideo",
  // Get series remote search.
  "/items/remotesearch/series",
  // Get trailer remote search.
  "/items/remotesearch/trailer",
  // Gets the root folder from a user's library.
  "/items/root",
  // Gets suggestions.
  "/items/suggestions",
  // Updates an item.
  "/items/{itemid}",
  // Gets all parents of an item.
  "/items/{itemid}/ancestors",
  // Gets the collections that include the specified item.
  "/items/{itemid}/collections",
  // Gets critic review for an item.
  "/items/{itemid}/criticreviews",
  // Downloads item media.
  "/items/{itemid}/download",
  // Get the original file of an item.
  "/items/{itemid}/file",
  // Get item image infos.
  "/items/{itemid}/images",
  // Delete an item's image.
  "/items/{itemid}/images/{imagetype}",
  // Delete an item's image.
  "/items/{itemid}/images/{imagetype}/{imageindex}",
  // Gets the item's image.
  "/items/{itemid}/images/{imagetype}/{imageindex}/{tag}/{format}/{maxwidth}/{maxheight}/{percentplayed}/{unplayedcount}",
  // Creates an instant playlist based on a given item.
  "/items/{itemid}/instantmix",
  // Gets intros to play before the main media item plays.
  "/items/{itemid}/intros",
  // Gets local trailers for an item.
  "/items/{itemid}/localtrailers",
  // Gets live playback media info for an item.
  "/items/{itemid}/playbackinfo",
  // Gets available remote images for an item.
  "/items/{itemid}/remoteimages",
  // Gets available remote image providers for an item.
  "/items/{itemid}/remoteimages/providers",
  // Search remote subtitles.
  "/items/{itemid}/remotesearch/subtitles/{language}",
  // Downloads a remote subtitle.
  "/items/{itemid}/remotesearch/subtitles/{subtitleid}",
  // Gets similar items.
  "/items/{itemid}/similar",
  // Gets special features for an item.
  "/items/{itemid}/specialfeatures",
  // Get theme songs and videos for an item.
  "/items/{itemid}/thememedia",
  // Get theme songs for an item.
  "/items/{itemid}/themesongs",
  // Get theme videos for an item.
  "/items/{itemid}/themevideos",
  // Existing plugin session endpoint.
  "/jellyfinenhanced/active-streams/sessions",
  // Existing plugin activity endpoint.
  "/jellyfinenhanced/activity",
  // AniList reviews, not local user reviews.
  "/jellyfinenhanced/anilist/reviews",
  // Plugin bootstrap.
  "/jellyfinenhanced/bootstrap",
  // Plugin client bundle.
  "/jellyfinenhanced/bundle.js",
  // Existing plugin item statistics endpoint.
  "/jellyfinenhanced/item-stats/{item}/{user}",
  // Existing plugin item endpoint.
  "/jellyfinenhanced/items",
  // Plugin JavaScript assets.
  "/jellyfinenhanced/js/{*asset}",
  // Plugin translations.
  "/jellyfinenhanced/locales/{locale}",
  // Production public configuration; relayed byte-identically, never rewritten.
  "/jellyfinenhanced/public-config",
  // Plugin loader.
  "/jellyfinenhanced/script",
  // Plugin tag presentation.
  "/jellyfinenhanced/tag-styles",
  // TMDB genre list (not Seerr genres).
  "/jellyfinenhanced/tmdb/genre/movie/list",
  // TMDB movie details with plugin credential.
  "/jellyfinenhanced/tmdb/movie/{id}",
  // TMDB movie search (not Seerr search).
  "/jellyfinenhanced/tmdb/search/movie",
  // TMDB credential status.
  "/jellyfinenhanced/tmdb/validate",
  // Plugin translation.
  "/jellyfinenhanced/translate",
  // Plugin language list.
  "/jellyfinenhanced/translate/languages",
  // Plugin version.
  "/jellyfinenhanced/version",
  // Provider presentation.
  "/jellyfinenhanced/watch-providers",
  // Closes a media source.
  "/livestreams/close",
  // Opens a media source.
  "/livestreams/open",
  // Gets available live tv channels.
  "/livetv/channels",
  // Gets a live tv channel.
  "/livetv/channels/{channelid}",
  // Get guide info.
  "/livetv/guideinfo",
  // Gets available live tv services.
  "/livetv/info",
  // Gets a live tv recording stream.
  "/livetv/liverecordings/{recordingid}/stream",
  // Gets a live tv channel stream.
  "/livetv/livestreamfiles/{streamid}/stream.{container}",
  // Gets available live tv epgs.
  "/livetv/programs",
  // Gets recommended live tv epgs.
  "/livetv/programs/recommended",
  // Gets a live tv program.
  "/livetv/programs/{programid}",
  // Gets live tv recordings.
  "/livetv/recordings",
  // Gets recording folders.
  "/livetv/recordings/folders",
  // Gets live tv recording groups.
  "/livetv/recordings/groups",
  // Get recording group.
  "/livetv/recordings/groups/{groupid}",
  // Gets live tv recording series.
  "/livetv/recordings/series",
  // Gets a live tv recording.
  "/livetv/recordings/{recordingid}",
  // Gets live tv series timers.
  "/livetv/seriestimers",
  // Gets a live tv series timer.
  "/livetv/seriestimers/{timerid}",
  // Gets the live tv timers.
  "/livetv/timers",
  // Gets the default values for a new timer.
  "/livetv/timers/defaults",
  // Gets a timer.
  "/livetv/timers/{timerid}",
  // Gets known countries.
  "/localization/countries",
  // Gets known cultures.
  "/localization/cultures",
  // Gets localization options.
  "/localization/options",
  // Gets known parental ratings.
  "/localization/parentalratings",
  // Gets all media segments based on an itemId.
  "/mediasegments/{itemid}",
  // Gets movie recommendations.
  "/movies/recommendations",
  // Gets similar items.
  "/movies/{itemid}/similar",
  // Gets all music genres from a given item, folder, or the entire library.
  "/musicgenres",
  // Creates an instant playlist based on a given genre.
  "/musicgenres/instantmix",
  // Gets a music genre, by name.
  "/musicgenres/{genrename}",
  // Get music genre image by name.
  "/musicgenres/{name}/images/{imagetype}",
  // Get music genre image by name.
  "/musicgenres/{name}/images/{imagetype}/{imageindex}",
  // Creates an instant playlist based on a given genre.
  "/musicgenres/{name}/instantmix",
  // Gets all persons.
  "/persons",
  // Get person by name.
  "/persons/{name}",
  // Get person image by name.
  "/persons/{name}/images/{imagetype}",
  // Get person image by name.
  "/persons/{name}/images/{imagetype}/{imageindex}",
  // Tests the network with a request with the size of the bitrate.
  "/playback/bitratetest",
  // Reports that a session has begun playing an item.
  "/playingitems/{itemid}",
  // Reports a session's playback progress.
  "/playingitems/{itemid}/progress",
  // Creates a new playlist.
  "/playlists",
  // Creates an instant playlist based on a given playlist.
  "/playlists/{itemid}/instantmix",
  // Updates a playlist.
  "/playlists/{playlistid}",
  // Adds items to a playlist.
  "/playlists/{playlistid}/items",
  // Moves a playlist item.
  "/playlists/{playlistid}/items/{itemid}/move/{newindex}",
  // Get a playlist's users.
  "/playlists/{playlistid}/users",
  // Get a playlist user.
  "/playlists/{playlistid}/users/{userid}",
  // Gets the remote lyrics.
  "/providers/lyrics/{lyricid}",
  // Gets the remote subtitles.
  "/providers/subtitles/subtitles/{subtitleid}",
  // Authorizes a pending quick connect request.
  "/quickconnect/authorize",
  // Attempts to retrieve authentication information.
  "/quickconnect/connect",
  // Gets the current quick connect state.
  "/quickconnect/enabled",
  // Initiate a new quick connect request.
  "/quickconnect/initiate",
  // Gets the search hint result.
  "/search/hints",
  // Gets a list of sessions.
  "/sessions",
  // Updates capabilities for a device.
  "/sessions/capabilities",
  // Updates capabilities for a device.
  "/sessions/capabilities/full",
  // Reports that a session has ended.
  "/sessions/logout",
  // Reports playback has started within a session.
  "/sessions/playing",
  // Pings a playback session.
  "/sessions/playing/ping",
  // Reports playback progress within a session.
  "/sessions/playing/progress",
  // Reports playback has stopped within a session.
  "/sessions/playing/stopped",
  // Reports that a session is viewing an item.
  "/sessions/viewing",
  // Issues a full general command to a client.
  "/sessions/{sessionid}/command",
  // Issues a general command to a client.
  "/sessions/{sessionid}/command/{command}",
  // Issues a command to a client to display a message to the user.
  "/sessions/{sessionid}/message",
  // Instructs a session to play an item.
  "/sessions/{sessionid}/playing",
  // Issues a playstate command to a client.
  "/sessions/{sessionid}/playing/{command}",
  // Issues a system command to a client.
  "/sessions/{sessionid}/system/{command}",
  // Adds an additional user to a session.
  "/sessions/{sessionid}/user/{userid}",
  // Instructs a session to browse to an item or view.
  "/sessions/{sessionid}/viewing",
  // Gets a list of next up episodes.
  "/shows/nextup",
  // Gets a list of upcoming episodes.
  "/shows/upcoming",
  // Gets similar items.
  "/shows/{itemid}/similar",
  // Gets episodes for a tv season.
  "/shows/{seriesid}/episodes",
  // Gets seasons for a tv series.
  "/shows/{seriesid}/seasons",
  // Jellyfin session WebSocket (the only allowed upgrade route).
  "/socket",
  // Creates an instant playlist based on a given song.
  "/songs/{itemid}/instantmix",
  // Gets all studios from a given item, folder, or the entire library.
  "/studios",
  // Gets a studio by name.
  "/studios/{name}",
  // Get studio image by name.
  "/studios/{name}/images/{imagetype}",
  // Get studio image by name.
  "/studios/{name}/images/{imagetype}/{imageindex}",
  // Notify SyncPlay group that member is buffering.
  "/syncplay/buffering",
  // Join an existing SyncPlay group.
  "/syncplay/join",
  // Leave the joined SyncPlay group.
  "/syncplay/leave",
  // Gets all SyncPlay groups.
  "/syncplay/list",
  // Request to move an item in the playlist in SyncPlay group.
  "/syncplay/moveplaylistitem",
  // Create a new SyncPlay group.
  "/syncplay/new",
  // Request next item in SyncPlay group.
  "/syncplay/nextitem",
  // Request pause in SyncPlay group.
  "/syncplay/pause",
  // Update session ping.
  "/syncplay/ping",
  // Request previous item in SyncPlay group.
  "/syncplay/previousitem",
  // Request to queue items to the playlist of a SyncPlay group.
  "/syncplay/queue",
  // Notify SyncPlay group that member is ready for playback.
  "/syncplay/ready",
  // Request to remove items from the playlist in SyncPlay group.
  "/syncplay/removefromplaylist",
  // Request seek in SyncPlay group.
  "/syncplay/seek",
  // Request SyncPlay group to ignore member during group-wait.
  "/syncplay/setignorewait",
  // Request to set new playlist in SyncPlay group.
  "/syncplay/setnewqueue",
  // Request to change playlist item in SyncPlay group.
  "/syncplay/setplaylistitem",
  // Request to set repeat mode in SyncPlay group.
  "/syncplay/setrepeatmode",
  // Request to set shuffle mode in SyncPlay group.
  "/syncplay/setshufflemode",
  // Request stop in SyncPlay group.
  "/syncplay/stop",
  // Request unpause in SyncPlay group.
  "/syncplay/unpause",
  // Gets a SyncPlay group by id.
  "/syncplay/{id}",
  // Gets application configuration.
  "/system/configuration",
  // jellyfin-web reads encoding defaults for member playback; other named configurations stay private.
  "/system/configuration/encoding",
  // Gets information about the request endpoint.
  "/system/endpoint",
  // Gets information about the server.
  "/system/info",
  // Gets public information about the server.
  "/system/info/public",
  // Pings the system.
  "/system/ping",
  // Gets the TMDb image configuration options.
  "/tmdb/clientconfiguration",
  // Finds movies and trailers similar to a given trailer.
  "/trailers",
  // Gets similar items.
  "/trailers/{itemid}/similar",
  // Marks an item as a favorite.
  "/userfavoriteitems/{itemid}",
  // Sets the user image.
  "/userimage",
  // Gets items based on a query.
  "/useritems/resume",
  // Deletes a user's saved personal rating for an item.
  "/useritems/{itemid}/rating",
  // Get Item User Data.
  "/useritems/{itemid}/userdata",
  // Marks an item as played for user.
  "/userplayeditems/{itemid}",
  // Gets a list of users.
  "/users",
  // Authenticates a user by name.
  "/users/authenticatebyname",
  // Authenticates a user with quick connect.
  "/users/authenticatewithquickconnect",
  // Updates a user configuration.
  "/users/configuration",
  // Initiates the forgot password process for a local user.
  "/users/forgotpassword",
  // Redeems a forgot password pin.
  "/users/forgotpassword/pin",
  // Gets the user based on auth token.
  "/users/me",
  // Updates a user's password.
  "/users/password",
  // Gets a list of publicly visible users for display on a login screen.
  "/users/public",
  // Gets a user by Id.
  "/users/{userid}",
  // Get user views.
  "/userviews",
  // Get user view grouping options.
  "/userviews/groupingoptions",
  // Stops an active encoding.
  "/videos/activeencodings",
  // Gets additional parts for a video.
  "/videos/{itemid}/additionalparts",
  // Gets a hls video playlist.
  "/videos/{itemid}/hls/{playlistid}/stream.m3u8",
  // Gets a hls video segment.
  "/videos/{itemid}/hls/{playlistid}/{segmentid}.{segmentcontainer}",
  // Gets a video stream using HTTP live streaming.
  "/videos/{itemid}/hls1/{playlistid}/{segmentid}.{container}",
  // Gets a hls live stream.
  "/videos/{itemid}/live.m3u8",
  // Gets a video stream using HTTP live streaming.
  "/videos/{itemid}/main.m3u8",
  // Gets a video hls playlist stream.
  "/videos/{itemid}/master.m3u8",
  // Gets a video stream.
  "/videos/{itemid}/stream",
  // Gets a video stream.
  "/videos/{itemid}/stream.{container}",
  // Upload an external subtitle file.
  "/videos/{itemid}/subtitles",
  // Gets an image tiles playlist for trickplay.
  "/videos/{itemid}/trickplay/{width}/tiles.m3u8",
  // Gets a trickplay tile image.
  "/videos/{itemid}/trickplay/{width}/{index}.jpg",
  // Gets an HLS subtitle playlist.
  "/videos/{itemid}/{mediasourceid}/subtitles/{index}/subtitles.m3u8",
  // Gets subtitles in a specified format.
  "/videos/{routeitemid}/{routemediasourceid}/subtitles/{routeindex}/stream.{routeformat}",
  // Gets subtitles in a specified format.
  "/videos/{routeitemid}/{routemediasourceid}/subtitles/{routeindex}/{routestartpositionticks}/stream.{routeformat}",
  // Get video attachment.
  "/videos/{videoid}/{mediasourceid}/attachments/{index}",
  // Jellyfin web page, scripts, styles, translations and client configuration.
  "/web/{*asset}",
  // Get years.
  "/years",
  // Gets a year.
  "/years/{year}",
];

function routePattern(template: string): RegExp {
  const parts = template.split(/(\{[^}]+\})/).map((part) =>
    part.startsWith('{*') ? '.+' : part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('')}$`);
}
const patterns = HOUSEHOLD_RELAY_ROUTES.map(routePattern);
// Audited against Jellyfin.Api.dll controller/method authorization metadata from both pinned images.
// test/fixtures/gateway-elevated-routes.json records the 85 elevated path templates and their methods.
// GET /System/Configuration is needed by jellyfin-web for member playback/UI settings;
// named configuration is limited to encoding (playback defaults), never arbitrary keys.
const elevatedMethods: Record<string, readonly string[]> = {
  "/auth/keys": ["GET", "POST"],
  "/auth/keys/{key}": ["DELETE"],
  "/auth/passwordresetproviders": ["GET"],
  "/auth/providers": ["GET"],
  "/backup": ["GET"],
  "/backup/create": ["POST"],
  "/backup/manifest": ["GET"],
  "/backup/restore": ["POST"],
  "/branding/splashscreen": ["DELETE", "POST"],
  "/devices": ["DELETE", "GET"],
  "/devices/info": ["GET"],
  "/devices/options": ["GET", "POST"],
  "/environment/defaultdirectorybrowser": ["GET"],
  "/environment/directorycontents": ["GET"],
  "/environment/drives": ["GET"],
  "/environment/networkshares": ["GET"],
  "/environment/parentpath": ["GET"],
  "/environment/validatepath": ["POST"],
  "/items/remotesearch/apply/{itemid}": ["POST"],
  "/items/remotesearch/person": ["POST"],
  "/items/{itemid}": ["POST"],
  "/items/{itemid}/contenttype": ["POST"],
  "/items/{itemid}/externalidinfos": ["GET"],
  "/items/{itemid}/images/{imagetype}": ["DELETE", "POST"],
  "/items/{itemid}/images/{imagetype}/{imageindex}": ["DELETE", "POST"],
  "/items/{itemid}/images/{imagetype}/{imageindex}/index": ["POST"],
  "/items/{itemid}/metadataeditor": ["GET"],
  "/items/{itemid}/refresh": ["POST"],
  "/items/{itemid}/remoteimages/download": ["POST"],
  "/library/mediafolders": ["GET"],
  "/library/physicalpaths": ["GET"],
  "/library/refresh": ["POST"],
  "/library/virtualfolders": ["DELETE", "GET", "POST"],
  "/library/virtualfolders/libraryoptions": ["POST"],
  "/library/virtualfolders/name": ["POST"],
  "/library/virtualfolders/paths": ["DELETE", "POST"],
  "/library/virtualfolders/paths/update": ["POST"],
  "/livetv/channelmappingoptions": ["GET"],
  "/livetv/channelmappings": ["POST"],
  "/livetv/listingproviders": ["DELETE", "POST"],
  "/livetv/listingproviders/schedulesdirect/countries": ["GET"],
  "/livetv/tunerhosts": ["DELETE", "POST"],
  "/livetv/tuners/discover": ["GET"],
  "/livetv/tuners/discvover": ["GET"],
  "/livetv/tuners/{tunerid}/reset": ["POST"],
  "/packages": ["GET"],
  "/packages/installed/{name}": ["POST"],
  "/packages/installing/{packageid}": ["DELETE"],
  "/packages/{name}": ["GET"],
  "/plugins": ["GET"],
  "/plugins/{pluginid}": ["DELETE"],
  "/plugins/{pluginid}/configuration": ["GET", "POST"],
  "/plugins/{pluginid}/manifest": ["POST"],
  "/plugins/{pluginid}/{version}": ["DELETE"],
  "/plugins/{pluginid}/{version}/disable": ["POST"],
  "/plugins/{pluginid}/{version}/enable": ["POST"],
  "/plugins/{pluginid}/{version}/image": ["GET"],
  "/repositories": ["GET", "POST"],
  "/scheduledtasks": ["GET"],
  "/scheduledtasks/running/{taskid}": ["DELETE", "POST"],
  "/scheduledtasks/{taskid}": ["GET"],
  "/scheduledtasks/{taskid}/triggers": ["POST"],
  "/startup/complete": ["POST"],
  "/startup/configuration": ["GET", "POST"],
  "/startup/firstuser": ["GET"],
  "/startup/remoteaccess": ["POST"],
  "/startup/user": ["GET", "POST"],
  "/system/activitylog/entries": ["GET"],
  "/system/configuration": ["POST"],
  "/system/configuration/branding": ["POST"],
  "/system/configuration/metadataoptions/default": ["GET"],
  "/system/configuration/{key}": ["POST"],
  "/system/info/storage": ["GET"],
  "/system/logs": ["GET"],
  "/system/logs/log": ["GET"],
  "/system/mediaencoder/path": ["POST"],
  "/system/restart": ["POST"],
  "/system/shutdown": ["POST"],
  "/users/new": ["POST"],
  "/users/{userid}": ["DELETE"],
  "/users/{userid}/policy": ["POST"],
  "/videos/mergeversions": ["POST"],
  "/videos/{itemid}/alternatesources": ["DELETE"],
  "/videos/{itemid}/subtitles/{index}": ["DELETE"],
  "/web/configurationpages": ["GET"],
};
const elevatedPatterns = Object.entries(elevatedMethods).map(([path, methods]) => ({ pattern: routePattern(path), namespace: new RegExp(routePattern(path).source.slice(0, -1) + '(?:/|$)'), methods }));
// Library setup/options and external filesystem-update hooks are dashboard/integration operations,
// even where Jellyfin uses ordinary authorization rather than an elevation policy.
const adminNamespace = /^\/(?:plugins|auth|packages|repositories|scheduledtasks|devices|backup|startup|environment|libraries)(?:\/|$)|^\/(?:library\/(?:virtualfolders|refresh|physicalpaths|mediafolders|media|movies|series)|system\/(?:activitylog|logs|restart|shutdown|info\/storage)|livetv\/(?:tunerhosts|tuners|listingproviders|channelmapping)|web\/configurationpages?)(?:\/|$)|^\/users\/(?:new|[^/]+\/policy)$|^\/items\/(?:remotesearch|[^/]+\/remoteimages)(?:\/|$)/;
export function householdRouteAllowed(route: string, additional: readonly string[] = [], method = 'GET'): boolean {
  if (!['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'].includes(method)) return false;
  if (adminNamespace.test(route) || elevatedPatterns.some(({ pattern, methods }) => pattern.test(route) && methods.includes(method === 'HEAD' ? 'GET' : method))) return false;
  if (route.startsWith('/system/configuration/') && route !== '/system/configuration/encoding') return false;
  return patterns.some((pattern) => pattern.test(route)) || additional.includes(route);
}

/** Exact canonical paths only: no namespace wildcards, queries, encodings or legacy-prefix ambiguity. */
const historicalRefusal = /^\/(?:streamyfin(?:\/|$)|jellyfinenhanced\/(?:jellyseerr|arr|proxy|reviews|items\/by-providers|tmdb\/(?:search\/(?:person|keyword)|genres\/(?:movie|tv)))(?:\/|$))/;
export function historicallyRefusedPluginRoute(route: string): boolean { return historicalRefusal.test(route); }
export function parseAdditionalPluginRoutes(input: string | undefined): string[] {
  const paths = [...new Set((input ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
  // Configuration may add an endpoint but cannot re-enable a historical privacy refusal.
  // This is only an override fence: the relay boundary itself is the allow-list above.

  if (paths.some((value) => historicalRefusal.test(value) || adminNamespace.test(value) || elevatedPatterns.some(({ namespace }) => namespace.test(value)) || value.startsWith('/system/configuration') || !/^\/[a-z0-9_-]+(?:\/[a-z0-9_.-]+)*$/.test(value) || value.split('/').some((part) => part === '.' || part === '..') || /^\/(?:emby|mediabrowser)(?:\/|$)/.test(value))) {
    throw new Error('HOUSEHOLD_PLUGIN_ROUTES must contain comma-separated exact lowercase paths without wildcards, encodings, legacy prefixes or elevated/admin namespaces or historically refused plugin endpoints');
  }
  return paths;
}
