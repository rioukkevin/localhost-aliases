# Swift menu-bar app. System frameworks only — no SwiftPM, no dependencies.
#
#   make build   compile the binary into build/
#   make app     assemble Contents/MacOS + Info.plist into the .app
#   make clean   remove build output
#
# `app` never deletes Contents/Resources: packages/build/bundle.sh fills that directory with
# bun, the dashboard, the forwarder and privileged/, and the two steps must be order-independent.

.PHONY: help build app clean

VERSION   ?= 2.0.0
NAME      := LocalhostAliases
BUILD     := build
DIST      ?= ../../dist
APP       ?= $(DIST)/$(NAME).app
DEPLOY    ?= 13.0
SDK       := $(shell xcrun --show-sdk-path --sdk macosx)
SOURCES   := $(wildcard Sources/*.swift)

SWIFTFLAGS := -O -wmo \
	-target arm64-apple-macos$(DEPLOY) \
	-sdk $(SDK) \
	-framework AppKit \
	-framework Foundation

help:
	@echo "make build   compile $(BUILD)/$(NAME)"
	@echo "make app     assemble $(APP)"
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

clean:
	@rm -rf $(BUILD)
	@rm -rf "$(APP)/Contents/MacOS" "$(APP)/Contents/Info.plist" "$(APP)/Contents/PkgInfo"
	@echo "cleaned"
