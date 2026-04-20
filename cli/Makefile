## Tanzen CLI build targets
##
## Usage:
##   make           — build both binaries into cli/bin/
##   make install   — build + install to /usr/local/bin
##   make dev       — install to ~/go/bin (no sudo)
##   make clean     — remove cli/bin/

GOFLAGS    ?= -trimpath
LDFLAGS    ?= -s -w
BINDIR     := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))bin
INSTALLDIR ?= /usr/local/bin
DEVDIR     ?= $(HOME)/go/bin

.PHONY: all build admin client install dev clean

all: build

build: admin client

admin:
	@echo "Building tanzenctl..."
	@mkdir -p $(BINDIR)
	cd admin && go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BINDIR)/tanzenctl .

client:
	@echo "Building tanzen..."
	@mkdir -p $(BINDIR)
	cd client && go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BINDIR)/tanzen .

install: build
	@echo "Installing to $(INSTALLDIR) (may require sudo)"
	install -m 755 $(BINDIR)/tanzenctl $(INSTALLDIR)/tanzenctl
	install -m 755 $(BINDIR)/tanzen    $(INSTALLDIR)/tanzen

dev: build
	@echo "Installing to $(DEVDIR)"
	@mkdir -p $(DEVDIR)
	install -m 755 $(BINDIR)/tanzenctl $(DEVDIR)/tanzenctl
	install -m 755 $(BINDIR)/tanzen    $(DEVDIR)/tanzen

clean:
	rm -rf $(BINDIR)
