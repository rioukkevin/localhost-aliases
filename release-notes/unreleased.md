### Added

- HTTPS for every alias, with the certificate issued automatically when you turn it on — aliases are no longer http-only.
- An uninstall option inside the app, so you can remove it entirely from there.
- Stack detection, so the app recognises what a project runs on.
- An offline page for an alias whose dev server isn't answering.
- An option to have the app start at login.
- Onboarding now opens by itself the first time you launch the app.
- A website with a download page, an FAQ, an animated homepage and a list of GitHub releases.

### Fixed

- A renewed certificate now actually reaches the connection, instead of the previous one staying in use.
- The forwarder failed to start when the app came up behind the admin prompt.
- Packaged builds resolved their bundle paths as if they were development builds.

### Changed

- Aliases now default to `.test` instead of `.local`, which was adding about five seconds to every request.
- Traffic is handled by a raw TCP forwarder in place of the old HTTP proxy.
- The app is one page now — project grid, drawers and status in the corner — and the nav rail is gone.
- Alias changes are applied for you, and admin rights are requested once per launch rather than per change; the dashboard button raises that prompt through the tray.
- The tray lists only aliases that are currently live.
- The project drawer is wider and can rescan.
