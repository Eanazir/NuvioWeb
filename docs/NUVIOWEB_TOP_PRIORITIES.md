# NuvioWeb top priorities

A short roadmap focused on bringing NuvioWeb to parity with Android NuvioTV — making the free app work well, feel fast, and stay clean. It intentionally excludes unit-test and engineering-infrastructure projects.

Every item is anchored to the current code on **both** sides — NuvioWeb (`webfile.js:line`) for the current behavior and NuvioTV (`SomeFile.kt:line`) for the Android behavior it should match — so maintainers can jump straight to the relevant paths. Items were verified against both repositories; where an earlier framing overstated a gap or misdescribed the code, it has been narrowed to what the code actually does.

**Contribution path tags** (per [`CONTRIBUTING.md`](../CONTRIBUTING.md)): 🟢 **PR-ready** — a reproducible bug/regression fix that restores intended behavior and can be submitted directly with proof. 🟡 **Feature-request-gated** — an architecture, behavior, or feature change that needs a maintainer-approved feature-request issue *before* any PR (large changes without one "will not be reviewed at all"). Nothing here is a cosmetic/redesign change; every item restores parity with the native app.

> **Dead-stub caveat for contributors:** `js/ui/components/catalogRow.js` and `js/ui/screens/detail/episodesSection.js` are legacy stubs that are no longer imported anywhere. The live catalog/home rendering is in `js/ui/screens/home/homeScreen.js`; the live TV detail/episode rendering is in `js/ui/screens/detail/metaDetailsScreen.js`. Do not implement changes against the stubs.

---

## 5 performance improvements

NuvioWeb feels markedly slower than native NuvioTV across the whole app. The root causes are systemic: a monolithic bundle, full-string DOM rebuilds instead of diffing, and no list virtualization — the things Compose gives Android for free. These five are ranked by user-perceptible impact on constrained 2020+ Tizen/webOS hardware.

### 1. Everything loads before first paint — one ~3 MB ES5 bundle with all 22 screens eagerly imported 🟡

NuvioWeb ships a single monolithic `app.bundle.js` (`index.html:110`), built as one IIFE with no code-splitting and transpiled all the way down to ES5 targeting `chrome 38` (`scripts/build.mjs:496-551`). The router statically imports **all 22 screens** at module load — including the 15,825-line `playerScreen.js` and 8,853-line `metaDetailsScreen.js` — into its `routes` map (`js/ui/navigation/router.js:1-22,70-93`), and there is no dynamic `import()` anywhere. So a weak single-threaded TV CPU must parse and compile ~3 MB of ES5 (larger and slower to parse than modern JS) before anything renders. Android class-loads each screen lazily via the ART VM — a Compose screen's code isn't touched until it's navigated to.

**Expected parity:** introduce route-level lazy loading (`import()` + esbuild `splitting`) so Player/Details/Settings aren't parsed at launch, approximating Android's lazy class-loading.

### 2. Whole screens are rebuilt via `innerHTML` on small state changes, with no list virtualization 🟡

The home screen serializes its entire DOM — sidebar, all catalog rows, all poster cards, hero — into one template literal and assigns it in a single `this.container.innerHTML = ...` (`js/ui/screens/home/homeScreen.js:7403`), and this fires from ~16 call sites including every streaming catalog batch (`:7233`, `:7243`) and watched/continue-watching updates (`:6740`, `:6972`). Nothing is windowed: `renderModernHomeLayout` emits markup for all rows × up to 15 posters each (`modernHomeLayout.js:49-107`, `homeConstants.js:28`), so hundreds of live `<img>` nodes exist at once; the library grid does the same for the full item list (`libraryScreen.js:551-577`). Each rebuild destroys and reparses the subtree and re-decodes every image. Android composes only visible cells via `LazyColumn`/`LazyRow` (`ModernHomeRows.kt:816`) and diffs state changes so only the affected row recomposes.

**Expected parity:** patch only changed nodes instead of rebuilding the shell, and window off-screen rows/cards, matching Compose's granular recomposition + lazy lists. (Some over-renders — e.g. rebuilding the whole home when only watched badges changed, `homeScreen.js:6740` — can be narrowed as scoped regression fixes; full virtualization is the gated architectural piece.)

### 3. Layout thrash: `getBoundingClientRect()` reads interleaved with scroll writes on every focus move 🟢

The focus hot path calls visibility helpers on every arrow press (`homeScreen.js:6227-6229`), and `applyClassicMainVerticalVisibility` reads `main.getBoundingClientRect()` and `anchor.getBoundingClientRect()` then immediately writes a scroll (`:6086-6101`) — a classic read-then-write reflow cycle repeated per keypress, across ~17 rect reads in `homeScreen.js` alone. Held-key repeat routes through `FocusEngine.handleKey` with no throttling (`js/ui/navigation/focusEngine.js:144-150`), so holding a D-pad direction fires the full forced-reflow + `querySelectorAll` cycle at key-repeat rate. Compose measures layout once per frame; focus movement triggers no per-key forced reflow.

**Expected parity:** batch layout reads before writes (and/or cache rects) and throttle held-key repeats so scrolling doesn't stall the main thread. Localized and measurable — the single most-felt "laggy remote" interaction.

### 4. Expensive CSS effects are not actually stripped on constrained TVs 🟢

`css/components.css` (~446 KB) carries 30 `backdrop-filter`, 158 `box-shadow`, 24 `will-change`, and 31 `infinite` animations — e.g. live `backdrop-filter: blur(26px)` (`:2498`) and blur on detail/stream surfaces (`:11734`, `:14168`). The `performance-constrained` mode only *shortens* animation/transition durations (`components.css:16605-16610`, toggled at `js/app.js:146-178`); it does **not** remove blur, `backdrop-filter`, or heavy shadows, and it leaves several `infinite` animations running (`:16622`, `:16630`, `:16634-16643`). On weak 2020 TV GPUs with often-unaccelerated WebKit blur, these are per-frame expensive and keep the compositor busy even when idle. Android leans on precomputed gradients (`ClassicFocusGradientBackdrop.kt`) rather than universal blur/shadow layering.

**Expected parity:** extend the existing `performance-constrained` block to null out `backdrop-filter`/`blur`/heavy `box-shadow` and stop `infinite` animations on constrained devices. Low-risk, high-yield, and builds on machinery that already exists.

### 5. No image-memory ceiling or downscaling — the app gets slower the more you browse 🟡

NuvioWeb has no in-memory decoded-image cap: `homeImageCacheStore.js` caps only a URL list (500 entries, `:4`), not decoded bitmaps, and there is no screen-level image release on navigation (the nav layer `js/ui/navigation/screen.js` exposes no dispose hook; nothing clears `img.src` on route change). Posters load at whatever size the addon provides with no downscaling to the TV's actual card size (`homeScreen.js:2146`), and each full-screen rebuild (item 2) re-decodes them. Combined with hundreds of non-virtualized posters, decoded bitmaps accumulate until the WebView hits memory pressure → GC stalls and re-decodes. Android caps Coil at `maxSizePercent(0.33)`, halves bitmap bytes with `allowRgb565(true)`, downscales to the target size with `precision(INEXACT)`, and limits decode parallelism (`NuvioApplication.kt:104-119`).

**Expected parity:** introduce a bounded decoded-image strategy (cap + release off-screen images on exit) and request TV-appropriate poster sizes, mirroring Coil's memory cap and RGB565 downscaling. (Selecting a smaller poster URL is a scoped perf fix; the memory-cap manager is the gated architectural piece.)

---

## 5 missing features

Each of these is fully implemented on Android and either absent or "coming soon" on the TV web build. All are behavior/feature additions, so per `CONTRIBUTING.md` they require an approved feature-request issue before implementation.

### 1. Collection management on TV 🟡

Android has a dedicated management screen with create/delete/reorder (`CollectionManagementScreen.kt:236,274-280`; `CollectionManagementViewModel.kt:60,67,78`) and a full editor for renaming collections and adding/renaming/reordering/removing folders (`CollectionEditorViewModel.kt:203,219,231,236,242,263,1124`), persisted via `CollectionsDataStore.kt:75,83,94`. NuvioWeb already models the same data with CRUD helpers in the store (`collectionsStore.js:264,288,299`), but no UI calls the write helpers — the only TV screen is a read-only viewer (`folderDetailScreen.js` reads at `:701`, key handler only does `selectTab`/`openDetail` at `:1498,1505`); editing exists only on the phone remote page.

**Expected parity:** create/rename/reorder/delete collections and folders directly on the TV, matching `CollectionManagementScreen.kt`; later add add-on catalog, TMDB, and Trakt sources.

### 2. Plugin management 🟡

Android ships a full plugin screen wiring add/remove/refresh repository, enable/disable providers, enabled state, and grouping (`PluginViewModel.kt:89-96,109,145,158,185,222`), with enforced execution limits — `SCRAPER_TIMEOUT_MS = 120_000` and a concurrency `Semaphore` (`PluginManager.kt:59,211`). NuvioWeb's live route shows a literal "Plugin support is coming soon." (`pluginsScreen.js:37`, `settingsScreen.js:3533`) while the stream runtime already exists (`pluginManager.js`, `pluginRuntime.js:28-88`). Repository-card UI (refresh/remove buttons) is even already authored but not wired into `renderPluginsSection` (`settingsScreen.js:2377-2404`).

**Expected parity:** wire up and extend the existing scaffolding into repository add/remove/refresh, provider enable/disable, status, and safe execution limits, matching Android's `PluginScreen`.

### 3. Direct add-on management (including install-by-URL) 🟡

Android's `AddonManagerScreen.kt` supports install-by-URL (`AddonManagerViewModel.kt:121,129,161`) plus enable/disable/remove/reorder on the TV (`:212,218,224,246`; UI at `AddonManagerScreen.kt:315,460,473`); the phone/QR flow is optional there. NuvioWeb's repository supports the same operations (`addonRepository.js:377-433`), but the TV screen offers only "manage from phone" (QR), reorder/hide catalogs, and refresh (`pluginScreen.js:198-256`) — enable/disable/remove and install-by-URL exist only on the `?addonsRemote=1` phone page (`renderAddonRemotePage.js:299-386`).

**Expected parity:** bring enable/disable/remove/reorder and install-by-URL onto the TV without requiring a phone, matching `AddonManagerScreen.kt`.

### 4. Sync without restarting 🟡

Android offers an explicit `requestSyncNow()`/`requestAddonSyncNow()` trigger (`StartupSyncService.kt:146,176`) surfaced as a user-facing "Sync now" with syncing/completed status (`TraktViewModel.kt:256`), a `SyncOverview` status card with per-profile stats (`AccountSettingsContent.kt:152-156,194`), **and** realtime auto-refresh when phone changes arrive via a Supabase `postgresChangeFlow` subscription (`RealtimeSyncInvalidationService.kt:60,176,219`). NuvioWeb has none of this surfaced: sync is a 120s background poll (`startupSyncService.js:17,76`) with a buried "Refresh addons" pull (`pluginScreen.js:84`) and a read-only account overview (`accountSettingsContent.js:87-133`); grep for `Sync now`/`lastSync` returns nothing, and there is no realtime subscription.

**Expected parity:** add a **Sync now** action, last-sync/error status, and automatic refresh when phone changes arrive, matching Android's trigger + status card + realtime invalidation.

### 5. Better playback preferences 🟡

Android persists and exposes all five, all missing on Web: **remember subtitle delay** across sessions (per-video, `TrackPreferenceDataStore.kt:97,104`, restored at `PlayerRuntimeControllerScrobble.kt:63-66`) — Web resets it per session and explicitly strips it from persisted settings (`playerScreen.js:2226`, `playerSettingsStore.js:126`); **secondary audio language** (`PlayerSettingsDataStore.kt:234,1100`) — no field/UI on Web; **separate intro/recap/outro auto-skip** toggles (`PlayerSettingsDataStore.kt:374-377,1132`; three switches at `PlaybackSettingsSections.kt:419-449`) — Web gates all three with one `skipIntroEnabled` flag (`playerSettingsStore.js:12`, `settingsScreen.js:5044`) even though per-type skip buttons already render (`playerScreen.js:1874-1880`); **subtitle background** color (`PlayerSettingsDataStore.kt:554,1416`) — Web has outline but no background; and a **secondary/filtered preferred subtitle language** (`PlayerSettingsDataStore.kt:546-547,1404-1405`) — Web has only a primary selector (`settingsScreen.js:5142`), though `secondarySubtitleLanguage` already exists unwired in the store (`playerSettingsStore.js:9`). Web already ships subtitle **outline** + color/bold (`settingsScreen.js:5194`) and the **primary** subtitle-language selector, so those are out of scope.

**Expected parity:** add the four genuinely-missing preferences (persisted subtitle delay, secondary audio language, per-segment skip toggles, subtitle background) and extend the existing primary subtitle-language selector with the secondary/filtered option.

---

## 5 reliability and cleanliness improvements

These are the highest-severity user-facing failure modes, all confirmed on both sides. Playback recovery was investigated and **dropped** — NuvioWeb already implements compatible-engine fallback (`playerController.js:2293-2388`), per-URL loop guards (`:2255-2283`), position preservation (`playerScreen.js:8737`), and clean return to source selection (`:9414-9432`), matching Android's `onPlayerError` retry chain, so parity is effectively met.

### 1. Stream discovery hangs forever on one dead source, and autoplay waits for every source before its countdown 🟢

`streamRepository.getStreamsFromAllAddons` fans out with `await Promise.all(addonTasks)` (`streamRepository.js:196`) over an `httpClient` that has **no timeout or `AbortController`** (`httpClient.js:44-51`), and `streamScreen` only clears `loading` after that promise resolves (`streamScreen.js:1311`) and only evaluates autoplay afterward, then starting a *separate* countdown (`streamScreen.js:1337,1398`). So a single stalled addon pins the picker on loading cards forever with no error, and autoplay is needlessly delayed behind the slowest source. Android bounds every request (OkHttp `connectTimeout 30s`/`readTimeout 60s`, `NetworkModule.kt:111-112`; `withTimeoutOrNull(120_000)`, `PluginManager.kt:59`), emits streams incrementally per addon, and treats the autoplay timeout as a max-wait that auto-selects from whatever arrived (`StreamRepositoryImpl.kt:187-193`, `StreamScreenViewModel.kt:769-771`). Leaving the screen also can't cancel web requests — cleanup only bumps `loadToken` (`streamScreen.js:2581`).

**Expected parity:** add a per-request timeout/`AbortController` to `httpClient`, evaluate autoplay progressively as chunks arrive (the `onChunk` callback already exists) with the configured timeout as a max-wait, and cancel in-flight requests on exit. Failure mode: one flaky addon → stream screen spins indefinitely, nothing selectable, no error.

### 2. "See All" and Discover pagination spin forever on a hung addon — the timeout guard Home already uses is missing 🟢

Home defensively wraps every catalog fetch in `withTimeout(catalogRepository.getCatalog(...), timeoutMs, ...)` (`homeScreen.js:7097-7106`), but See-All calls it bare (`catalogSeeAllScreen.js:232`) and Discover does too (`discoverScreen.js:547`). Since `getCatalog` uses the timeout-less `httpClient` (`catalogRepository.js:45`), a stalled addon leaves `this.loading = true` (`catalogSeeAllScreen.js:223`) and never clears it, which also blocks all further paging (the load guards early-return while loading, `:214,285,293`). Android has no such per-screen inconsistency — the same OkHttp timeouts apply to every catalog request through the shared client.

**Expected parity:** apply the same bounded `withTimeout` wrapper Home already uses to See-All and Discover so a hung addon degrades gracefully instead of freezing pagination. This is a clean internal-inconsistency regression fix.

### 3. A transient Wi-Fi blip becomes a hard "no streams" error — no connection-failure retry 🟡

`httpClient.httpRequest` retries only on HTTP 401 after a token refresh (`httpClient.js:53-67`); any transient transport failure (DNS hiccup, dropped TV-Wi-Fi socket) rejects immediately and surfaces via `safeApiCall` as a failed source with no second attempt (`safeApiCall.js:8-14`). Android relies on OkHttp's `retryOnConnectionFailure` (default on, explicit on the playback/subtitle/media clients — `PlayerPlaybackNetworking.kt:52`, `PlayerMediaSourceFactory.kt:84`), so a single connection drop is silently re-attempted.

**Expected parity:** retry transient (non-HTTP) connection failures once on core requests, matching OkHttp's behavior, instead of failing the source outright. (Networking behavior change → needs an approved issue.)

### 4. WebAudio `AudioContext` graph is never closed on player teardown — a resource leak over long sessions 🟢

The amplification graph is built lazily (`new AudioContext()`, `createMediaElementSource`, `createGain`, `connect` — `playerScreen.js:6383-6392`), but the otherwise-thorough `cleanup()` (`:15699-15823`) never calls `audioContext.close()` or disconnects the nodes, and `PlayerController.stop()` doesn't touch them either (`playerController.js:3850-3880`). Because the nodes hang off a reused singleton, the suspended context and its native mixer resources accumulate across episodes. Android disposes its audio path deterministically on `releasePlayer` (`PlayerRuntimeControllerLifecycle.kt:11-72`, `PlayerRuntimeController.kt:582-593`).

**Expected parity:** disconnect and close the AudioContext (and null the references) on player cleanup, matching Android's lifecycle-scoped audio release. Failure mode: over a long viewing session, audio amplification can silently stop or glitch until app restart.

### 5. Meta lookup walks addons sequentially with no per-candidate timeout 🟢

`metaRepository.getMetaFromAllAddons` loops candidates one at a time with `await this.getMeta(...)` (`metaRepository.js:108-114`), and `getMeta` again uses the timeout-less `httpClient` (`:32`). The detail screen shields itself with a `withTimeout(..., 4500, ...)` (`metaDetailsScreen.js:1653`), but other callers don't — the player's pause-overlay hydration awaits it bare (`playerScreen.js:5311`) — so a slow addon can wedge metadata resolution and serially delay fallback to healthy addons. Android bounds each `api.getMeta` through the same OkHttp timeouts and normalizes a `timeout` failure (`MetaRepositoryImpl.kt:486-487`).

**Expected parity:** enforce a bounded per-candidate timeout at the repository layer (as Android's OkHttp does) rather than relying on individual screens to wrap the aggregate call. Shares its root cause with items 1–2 (no transport-level timeout in `httpClient`).

---

## Additional observed parity items

*(These concrete, code-confirmed bugs are the lowest-risk starting points — each is a reproducible bug/UI-glitch fix that can be filed as a separate, narrowly scoped issue and PR with before/after proof, per `CONTRIBUTING.md`.)*

### Bug: Modern Home focused-card preview updates too slowly

The focus highlight moves immediately, but the large preview/backdrop at the top can update noticeably later than Android NuvioTV. The debounce constants are already correct and identical to Android — about 450 ms for a normal focus move and about 400 ms after rapid horizontal navigation (`modernHomeLayout.js:1-4`, `homeScreen.js:3100-3105`/`4515-4520`; Android `ModernHomeModels.kt:29`, `ModernHomeRowsList.kt:375-379`). The lag comes from what happens after the debounce fires: an extra `requestAnimationFrame` before commit (`homeScreen.js:4532`), a backdrop crossfade gated on full image preload (`:423`/`:462`), and optional hero enrichment with up to a 4000 ms network wait (`:4572`). Web should preserve the debounce without adding these post-debounce render, enrichment, or image-loading delays.

**Expected parity:** moving to an adjacent card should feel nearly immediate after the normal settle delay. When moving rapidly across many cards, intermediate previews should be skipped and the final card's preview should appear promptly after navigation stops.

### Missing feature: Show buffered media on the player progress bar

Android NuvioTV displays a lower-opacity accent bar ahead of the solid playback-position bar to show how much of the stream is already buffered (`PlayerScreen.kt:2120-2122`/`2221-2231`, fed by ExoPlayer's `bufferedPosition`). NuvioWeb's progress bar is a single track + single played fill only (`playerScreen.js:4325-4329`, `components.css:11370-11392`); no engine exposes a buffered-time API and there is no `video.buffered`/`TimeRanges` usage (the only "buffered" text is torrent bytes-downloaded, `playerScreen.js:4503-4504`).

**Expected parity:** read the active engine's reliable buffered position, draw it underneath the played fill, animate updates smoothly, and hide it when the engine cannot report a meaningful buffered range. It must represent playable media time, not torrent download percentage.

### Missing feature: Show step-by-step player startup status

Android NuvioTV can show live status text below the title or logo while an episode or movie starts — Preparing stream, Detecting stream format, Fetching subtitles, per-add-on subtitle progress, Building player, Starting stream, and Buffering (`strings.xml:1446-1454`, fed from real lifecycle points). Its **Show loading status** playback setting is enabled by default (`PlayerSettingsDataStore.kt:236`). NuvioWeb already has a loading overlay and status element (`playerScreen.js:4248-4270`), but normal startup does not feed those stages into it: `syncLoadingOverlayStatus()` is driven only by torrent/EngineFS stats (`:4568-4586`, `:4488-4507`), no stage strings exist, and there is no "Show loading status" setting (`playbackSettings.js:7-28`).

**Expected parity:** add the default-on playback setting and drive the existing loading overlay from real lifecycle events rather than timers. Update or crossfade the message as each applicable stage begins, include subtitle add-on counts or progress when known, omit stages that do not apply to the selected engine, and stop updating after the first playable frame or when playback is cancelled or fails.

### Bug: Focused episode cards are oversized on first open and lose centering after the first focus

Two distinct defects on the TV detail screen (`metaDetailsScreen.js` + `.series-episode-*` rules in `css/components.css`; note neither app scales the card on focus, and the settled size ~540×360 px is proportionally comparable to Android's tiers, so "much larger than Android" is not the core issue):

1. **Oversized on initial page open.** On first open the episode card renders much larger than steady state, then settles to normal size only after entering an episode and returning. Two competing `.series-episode-card` blocks exist (`components.css:14161` base `flex: 0 0 286px` vs the `:15610-15632` override `clamp(440px,29vw,540px)` / `clamp(286px,19vw,360px)`); the first-paint-versus-settled discrepancy is the likely culprit and still needs to be pinpointed to the exact render pass.
2. **Centering is one-shot, then the card clips.** All detail focus routes through `focusInList` (`metaDetailsScreen.js:7258-7323`), which re-anchors vertically to `DETAIL_ROW_FOCUS_TARGET = 0.33` only when `preserveVerticalScroll` is false (`:7287-7305`). The only episode path passing false is the return-from-player restore (`:4055-4059`), which is why the card centers correctly exactly once. Normal moves pass `preserveVerticalScroll: true`, so it never re-centers; and moving up to the season selector omits the flag entirely (`:7730`), re-anchoring the short season row at the 0.33 line and shoving the tall episode card below the fold so it clips at the bottom. (The doc previously attributed this to left/right movement, but horizontal moves already preserve scroll — `:4560`, `:7720` — so the trigger is upward navigation, not left/right.)

**Expected parity:** the season selector, complete episode thumbnail, and Creator and Cast area should remain visible together where the Android layout shows them, on first open and on every subsequent focus. Fixing the initial-render size and passing `preserveVerticalScroll` (or an episode-aware anchor) on the up-to-season transition should restore consistent framing. Moving within the detail screen must not repeatedly re-anchor the page so the focused episode clips.

### Bug: Focus outlines use the darker accent color on several screens

The seven Web theme palettes contain the same core values as Android NuvioTV, including separate `Secondary` and `FocusRing` colors — though the palettes live in `js/ui/theme/themeColors.js` and `css/base.css`, not the empty `css/themes.css`. In Crimson, `--secondary-color` is `#e53935` and `--focus-color` is `#ff5252` (`themeColors.js:20`/`27`), matching Android's `red500`/`red300` (`PrimitiveTokens.kt:24`/`26`). Several Web focus outlines use `--secondary-color` instead of `--focus-color`, so in Crimson highlighted thumbnails render with the darker `#E53935` instead of Android's brighter `#FF5252`.

Confirmed affected areas: Home posters (`components.css:5093-5094`, `5705-5706`, `6687-6688`), Continue Watching (`:4688`, `5795-5796`), See All cards (`:5288-5302`, `4579-4580`, `3512-3514`), Search and Discover cards and controls (`:3455-3456`, `2886-2887`, `2964-2965`, `3247-3248`), and Profile editor controls (`:1350-1355`, `1447-1451`, `1556-1563`). Already correct (use `--focus-color`): Detail episode cards (`:15639-15640`), More Like This (`:14769-14772`), Library grid (`:3859-3861`), account cards (`:291-294`), and selected sidebar items (`:2596-2598`).

Additional areas not previously listed also misuse `--secondary-color` for the focus ring: series stream cards/filters and stream-route chips/buttons (`components.css:14315-14318`, `14358-14361`, `16468-16470`, `16590-16594`, `19377-19381`). Separately, movie cast cards use a hardcoded `#fff` focus border rather than any theme token (`:14497-14500`).

**Expected parity:** use `--focus-color` for focus borders, rings, and focus-only glows across every theme (including the stream-selection surfaces and cast cards above). Keep `--secondary-color` for accent fills, active selections, progress, and other non-focus emphasis; a focused filled control may use a Secondary fill with a FocusRing outline. Do not change the palette hex values.

### Bug: Scrolling through streams (details TBD)

_Placeholder — details to be added. Something is wrong when scrolling through the stream list. Repro steps, affected platform/screen, and expected behavior to follow._

### Bug: Search (details TBD)

_Placeholder — details to be added. Search has a bug. Repro steps, affected behavior, and expected behavior to follow._

---

## Best order to tackle them

Sequenced so the low-risk, PR-ready fixes land first while the architectural work goes through feature-request approval in parallel:

1. **PR-ready reliability + perf quick wins:** `httpClient` timeout/`AbortController` (reliability 1/2/5), See-All/Discover timeout guard, WebAudio cleanup, layout-read batching (perf 3), and extending `performance-constrained` to strip blur/shadow/infinite animations (perf 4). Plus the concrete parity bugs above (focus-color token, episode-card scroll anchoring).
2. **PR-ready parity features that already have proof:** buffered progress bar and step-by-step startup status.
3. **Feature-request-gated architecture:** code-splitting/lazy screens, DOM diffing + list virtualization, and the image-memory cap — the systemic fixes behind "the whole app feels slower."
4. **Feature-request-gated features:** collection management, restart-free sync (trigger + status + realtime), then plugin/add-on management and the advanced playback preferences.

Features and behavior changes require a maintainer-approved feature-request issue before implementation. Reproduced bugs should remain separate, narrowly scoped issues and PRs with before/after proof.
