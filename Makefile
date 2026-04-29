## Tanzen top-level build
##
## Usage:
##   make              — build all components
##   make app          — frontend SPA (npm run build → app/dist/)
##   make server       — API server   (bun run build → server/dist/)
##   make worker       — Python worker (uv sync + wheel → worker/dist/)
##   make cli          — Go binaries  (tanzen + tanzenctl → cli/bin/)
##   make mcp          — MCP servers  (npm install in each mcp/* dir)
##   make test         — run all test suites
##   make typecheck    — TypeScript type-check (app + server)
##   make lint         — lint app
##   make clean        — remove all build artefacts

.PHONY: all app server worker cli mcp test typecheck lint clean

REPO_ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

all: app server worker cli mcp

# ── Frontend ──────────────────────────────────────────────────────────────────
app:
	@echo "==> app: installing dependencies"
	cd $(REPO_ROOT)app && npm install
	@echo "==> app: building SPA"
	cd $(REPO_ROOT)app && npm run build

# ── API server ────────────────────────────────────────────────────────────────
server:
	@echo "==> server: installing dependencies"
	cd $(REPO_ROOT)server && bun install
	@echo "==> server: building"
	cd $(REPO_ROOT)server && bun run build

# ── Python worker ─────────────────────────────────────────────────────────────
worker:
	@echo "==> worker: syncing dependencies"
	cd $(REPO_ROOT)worker && uv sync
	@echo "==> worker: building wheel"
	cd $(REPO_ROOT)worker && uv build

# ── CLI (Go) ──────────────────────────────────────────────────────────────────
cli:
	@echo "==> cli: building binaries"
	$(MAKE) -C $(REPO_ROOT)cli build

# ── MCP servers (Node) ────────────────────────────────────────────────────────
MCP_DIRS := falkordb fetch sequential-thinking

mcp: $(addprefix mcp-, $(MCP_DIRS))

mcp-%:
	@echo "==> mcp/$*: installing dependencies"
	cd $(REPO_ROOT)mcp/$* && npm install

# ── Tests ─────────────────────────────────────────────────────────────────────
test: test-app test-server test-worker

test-app:
	@echo "==> app: running tests"
	cd $(REPO_ROOT)app && npx vitest run

test-server:
	@echo "==> server: running tests"
	cd $(REPO_ROOT)server && bun test

test-worker:
	@echo "==> worker: running tests (requires cluster port-forwards)"
	cd $(REPO_ROOT)worker && uv run pytest

# ── Type-check ────────────────────────────────────────────────────────────────
typecheck: typecheck-app typecheck-server

typecheck-app:
	@echo "==> app: type-checking"
	cd $(REPO_ROOT)app && npx tsc --noEmit

typecheck-server:
	@echo "==> server: type-checking"
	cd $(REPO_ROOT)server && bun run typecheck

# ── Lint ──────────────────────────────────────────────────────────────────────
lint:
	@echo "==> app: linting"
	cd $(REPO_ROOT)app && npm run lint

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	@echo "==> app: cleaning"
	rm -rf $(REPO_ROOT)app/dist $(REPO_ROOT)app/dist-lib
	@echo "==> server: cleaning"
	rm -rf $(REPO_ROOT)server/dist
	@echo "==> worker: cleaning"
	rm -rf $(REPO_ROOT)worker/dist $(REPO_ROOT)worker/.venv
	@echo "==> cli: cleaning"
	$(MAKE) -C $(REPO_ROOT)cli clean
