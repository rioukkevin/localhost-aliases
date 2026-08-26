### Added

- HTTPS for every alias, with a certificate issued automatically when you switch it on.
- Aliases can be uninstalled entirely from within the app, so cleanup no longer has to be done by hand.
- Projects are checked for the stack they run on, so a new alias needs less setup.
- An offline page is shown when the dev server behind an alias isn't running, instead of a bare connection error.
- The app can start automatically when you log in.
- A rescan action in the app picks up projects that changed on disk.
- Onboarding opens by itself the first time you launch the app.
- A project site with a download page, an FAQ, and links to the GitHub releases.

### Fixed

- A renewed certificate now actually reaches the connection; previously the old one kept being served after renewal.
- Aliases now default to `.test` rather than `.local`, which was costing around five seconds on every request.
- The forwarder no longer fails to start when the app is running behind the administrator prompt, and a packaged build no longer resolves its paths as if it were a development build.

### Changed

- Alias changes are applied for you and grouped behind a single administrator prompt, asked once per launch, instead of one prompt per change. The dashboard button now triggers that prompt through the menu-bar item.
- Traffic is handed to your dev server by a raw TCP forwarder in place of the previous HTTP proxy.
- The interface is now one page: a project grid, drawers for details, and status in the corner, with the navigation rail removed. The drawer is also wider.
- The menu-bar menu lists only aliases that are currently live.
