### Added

- HTTPS for every alias: switch it on and a certificate is issued for you automatically, and a renewed certificate now takes effect on real traffic.
- Alias changes are applied for you as you make them, and the admin prompt is asked once per launch instead of once per change.
- An offline page for aliases whose dev server isn't answering.
- Stack detection for your projects.
- An option to start the app at login.
- A full uninstall you can run from inside the app.
- A rescan action to pick up projects that changed on disk.
- Onboarding opens by itself the first time you run the app.
- A website for the app, with a download page, an FAQ, a list of GitHub releases, and an animated homepage.

### Fixed

- The forwarder never started when the app was running under the admin prompt, so nothing was served.
- The packaged app resolved its bundled paths as if it were a development build.

### Changed

- Aliases now default to `.test` instead of `.local`; `.local` names were costing five seconds on every request.
- Traffic is forwarded at the TCP level rather than through an HTTP proxy.
- The app is a single page — a project grid, detail drawers, and status in the corner — replacing the navigation rail, and the drawer is wider.
- The tray menu lists only aliases that are currently live.
