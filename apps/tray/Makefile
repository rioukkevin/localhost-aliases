# Swift menu-bar app. System frameworks only — no SwiftPM, no dependencies.
#
#   make build   compile the binary into build/
#   make app     assemble Contents/MacOS + Info.plist into the .app
#   make clean   remove build output
#
# `app` never deletes Contents/Resources: packages/build/bundle.sh fills that directory with
# bun, the dashboard, the forwarder and privileged/, and the two steps must be order-independent.

.PHONY: help build app test clean

VERSION   ?= 2.0.0
NAME      := LocalhostAliases
BUILD     := build
DIST      ?= ../../dist
APP       ?= $(DIST)/$(NAME).app
DEPLOY    ?= 13.0
SDK       := $(shell xcrun --show-sdk-path --sdk macosx)
SOURCES   := $(wildcard Sources/*.swift)

# The harness links only the files it needs, and only AppKit-free ones (it builds against
# Foundation alone). Two files are deliberately NOT in this list, so `make test` can neither
# raise a password dialog nor touch the real login item:
#   Sources/PrivilegedApply.swift    the only `with administrator privileges` call
#   Sources/LoginItemService.swift   the only SMAppService register()/unregister() calls
# Both are injected into the code below as closures, so every decision is still exercised.
TEST_SOURCES := Sources/Paths.swift Sources/Logger.swift Sources/ApplyRequestWatcher.swift \
	Sources/TerminationCoordinator.swift Sources/AgentSupervisor.swift Sources/LoginItem.swift \
	Sources/AppConfig.swift Sources/AliasMenuList.swift Sources/RuntimeLayout.swift \
	Sources/Uninstaller.swift \
	tests/main.swift tests/TerminationTests.swift tests/AgentTests.swift \
	tests/LoginItemTests.swift tests/MenuTests.swift tests/UninstallTests.swift

SWIFTFLAGS := -O -wmo \
	-target arm64-apple-macos$(DEPLOY) \
	-sdk $(SDK) \
	-framework AppKit \
	-framework Foundation \
	-framework ServiceManagement

help:
	@echo "make build   compile $(BUILD)/$(NAME)"
	@echo "make app     assemble $(APP)"
	@echo "make test    build and run the ApplyRequestWatcher harness"
	@echo "make clean   remove $(BUILD) and the app's MacOS payload"

build: $(BUILD)/$(NAME)

$(BUILD)/$(NAME): $(SOURCES)
	@mkdir -p $(BUILD)
	@swiftc $(SWIFTFLAGS) -o $@ $(SOURCES)
	@echo "built $@"

app: build
	@mkdir -p "$(APP)/Contents/MacOS" "$(APP)/Contents/Resources"
	@cp $(BUILD)/$(NAME) "$(APP)/Contents/MacOS/$(NAME)"
	@sed 's/@VERSION@/$(VERSION)/g' Info.plist > "$(APP)/Contents/Info.plist"
	@printf 'APPL????' > "$(APP)/Contents/PkgInfo"
	@echo "assembled $(APP) (Resources are filled by packages/build/bundle.sh)"

test: $(BUILD)/watcher-tests
	@$(BUILD)/watcher-tests

$(BUILD)/watcher-tests: $(TEST_SOURCES)
	@mkdir -p $(BUILD)
	@swiftc -target arm64-apple-macos$(DEPLOY) -sdk $(SDK) -framework Foundation \
		-o $@ $(TEST_SOURCES)

clean:
	@rm -rf $(BUILD)
	@rm -rf "$(APP)/Contents/MacOS" "$(APP)/Contents/Info.plist" "$(APP)/Contents/PkgInfo"
	@echo "cleaned"
