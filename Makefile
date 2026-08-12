.PHONY: help install uninstall dev build test test-e2e app clean

BUN ?= bun

help:
	@echo "Localhost Aliases"
	@echo ""
	@echo "  make dev        Run helper + dashboard locally (no install, no login item)"
	@echo "  make build      Build the Next.js dashboard and the menu-bar app"
	@echo "  make install    Install the privileged helper + login agent (asks for sudo once)"
	@echo "  make uninstall  Remove everything, including the /etc/hosts managed block"
	@echo "  make test       Unit tests"
	@echo "  make test-e2e   Headless Chromium + MCP protocol tests"
	@echo "  make app        Build the menu-bar .app bundle only"

install: build
	@bash scripts/install.sh

uninstall:
	@bash scripts/uninstall.sh

dev:
	@bash scripts/dev.sh

build:
	@$(BUN) install
	@$(BUN) run --cwd packages/web build
	@$(MAKE) -C apps/tray app

app:
	@$(MAKE) -C apps/tray app

test:
	@$(BUN) test packages

test-e2e:
	@$(BUN) run --cwd e2e test

clean:
	@rm -rf packages/web/.next apps/tray/.build apps/tray/LocalhostAliases.app e2e/test-results
