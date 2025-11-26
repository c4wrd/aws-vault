.PHONY: dev build clean serve help

# Default target
help:
	@echo "Linux & Go Patterns Documentation Site"
	@echo ""
	@echo "Usage:"
	@echo "  make dev     - Start development server with drafts"
	@echo "  make serve   - Start development server (production mode)"
	@echo "  make build   - Build for production"
	@echo "  make clean   - Remove build artifacts"
	@echo ""

# Development server with drafts enabled
dev:
	hugo server --buildDrafts --bind 0.0.0.0

# Production-like server
serve:
	hugo server --bind 0.0.0.0

# Build for production
build:
	hugo --minify

# Clean build artifacts
clean:
	rm -rf public/ resources/_gen/

# Install theme (if submodule not initialized)
init:
	git submodule update --init --recursive

# Create a new pattern file
new-pattern:
	@read -p "Pattern number (e.g., 17): " num; \
	read -p "Pattern slug (e.g., my-pattern): " slug; \
	hugo new patterns/$$num-$$slug.md
