.PHONY: help hooks dev test build bundle sign dmg notarize install uninstall clean

BUN     ?= bun
DIST    ?= dist
APP     := $(DIST)/LocalhostAliases.app

help:
	@echo "Localhost Aliases v2"
	@echo "  make test       Unit tests"
	@echo "  make hooks      Enable the pre-push hook that writes release notes locally"
	@echo "  make dev        Run the dashboard in dev (no app, no privileges)"
	@echo "  make bundle     Build the unsigned .app into $(DIST)"
	@echo "  make sign       Codesign the bundle with your Developer ID"
	@echo "  make dmg        Package the signed app into a DMG"
	@echo "  make notarize   Notarize + staple (needs NOTARY_ARGS)"
	@echo "  make install    Copy the built app into /Applications"
	@echo "  make uninstall  Remove the app and every change it made (one admin prompt)"
	@echo "                  Delegates to the same teardown.sh the app itself runs"

# git only runs hooks from .git/hooks, which is not versioned. Pointing core.hooksPath at a
# tracked directory is the one line that makes .githooks/ real, and it is per-clone.
hooks:
	@git config core.hooksPath .githooks
	@echo "pre-push hook on: release notes are written by claude before a push (docs/RELEASE.md)"
	@echo "skip once with: LA_NOTES_SKIP=1 git push"

test:
	@$(BUN) test packages

dev:
	@$(BUN) run --cwd packages/dashboard dev

build: bundle

bundle:
	@bash packages/build/bundle.sh

sign:
	@bash packages/build/sign.sh

dmg:
	@bash packages/build/dmg.sh

notarize:
	@bash packages/build/notarize.sh

install: bundle
	@bash packages/build/install-local.sh

uninstall:
	@bash packages/build/uninstall.sh

clean:
	@rm -rf $(DIST) packages/dashboard/.next
