# Localhost Aliases — menu bar app.
# No SwiftPM, no dependencies: swiftc + the system frameworks, assembled into a .app by hand.

APP_NAME   := LocalhostAliases
BUNDLE     := $(APP_NAME).app
BUILD_DIR  := .build
BINARY     := $(BUILD_DIR)/$(APP_NAME)
TEST_BIN   := $(BUILD_DIR)/TrayTests
SOURCES    := $(wildcard Sources/*.swift)
# Everything but the entry point: the test runner brings its own `main.swift`.
LIB_SOURCES := $(filter-out Sources/main.swift,$(SOURCES))
TEST_SOURCES := $(wildcard Tests/*.swift)
HELPER_PLIST := LaunchDaemons/dev.localhost-aliases.helper.plist

ARCH       := $(shell uname -m)
DEPLOY_MIN := 13.0
SDK        := $(shell xcrun --show-sdk-path --sdk macosx)

# ServiceManagement is what registers the privileged helper and launch-at-login (macOS 13+).
SWIFTFLAGS := -target $(ARCH)-apple-macos$(DEPLOY_MIN) -sdk $(SDK) \
              -framework AppKit -framework Foundation -framework ServiceManagement

# Ad-hoc by default so `make app` needs no keychain access and raises no dialog.
# Production signing is `scripts/package/` — or pass the identity explicitly:
#   make app CODESIGN_ID="Developer ID Application: RIOU Kevin (UYB68P6HH7)"
CODESIGN_ID ?= -

.PHONY: all build app test run clean

all: app

## build — compile the executable into .build/
build: $(BINARY)

$(BINARY): $(SOURCES)
	@mkdir -p $(BUILD_DIR)
	swiftc -O $(SWIFTFLAGS) -o $@ $(SOURCES)

## test — compile and run the unit tests (pure logic; no AppKit UI is instantiated)
test: $(TEST_BIN)
	@$(TEST_BIN)

$(TEST_BIN): $(LIB_SOURCES) $(TEST_SOURCES)
	@mkdir -p $(BUILD_DIR)
	swiftc $(SWIFTFLAGS) -o $@ $(LIB_SOURCES) $(TEST_SOURCES)

## app — assemble LocalhostAliases.app next to this Makefile
##
## This produces the *tray half* of the production layout (docs/PHASE4.md §1):
## Contents/MacOS/LocalhostAliases + Contents/Library/LaunchDaemons/. The payload the
## installed app also carries — Contents/MacOS/la-helper, Contents/Resources/bin/bun and
## Contents/Resources/web — is added by scripts/package/. Without it the app falls back to
## running the dashboard from the checkout, which is what you want while developing.
app: build
	@rm -rf $(BUNDLE)
	@mkdir -p $(BUNDLE)/Contents/MacOS $(BUNDLE)/Contents/Resources $(BUNDLE)/Contents/Library/LaunchDaemons
	@cp Info.plist $(BUNDLE)/Contents/Info.plist
	@cp $(BINARY) $(BUNDLE)/Contents/MacOS/$(APP_NAME)
	@cp $(HELPER_PLIST) $(BUNDLE)/Contents/Library/LaunchDaemons/
	@printf 'APPL????' > $(BUNDLE)/Contents/PkgInfo
	@codesign --force --sign "$(CODESIGN_ID)" $(BUNDLE) \
	  || echo "note: codesign failed, bundle left unsigned"
	@echo "built $(CURDIR)/$(BUNDLE)"

## run — build and launch the app (it appears in the menu bar, not the dock)
run: app
	open $(BUNDLE)

## clean — remove build products
clean:
	rm -rf $(BUILD_DIR) $(BUNDLE)
