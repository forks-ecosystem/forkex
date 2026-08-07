.PHONY: build build-bot build-web run run-bot run-web test clean help

BIN_DIR := bin
BOT_BINARY := $(BIN_DIR)/bot
WEB_BINARY := $(BIN_DIR)/web

## Build targets
build: build-bot build-web

build-bot:
	@echo "Building bot..."
	@mkdir -p $(BIN_DIR)
	@go build -o $(BOT_BINARY) ./cmd/bot

build-web:
	@echo "Building web server..."
	@mkdir -p $(BIN_DIR)
	@go build -o $(WEB_BINARY) ./cmd/web

## Run targets
run: run-bot

run-bot: build-bot
	@echo "Starting bot..."
	@./$(BOT_BINARY)

run-web: build-web
	@echo "Starting web server..."
	@./$(WEB_BINARY)

## Development
dev:
	@go run cmd/bot/main.go

dev-web:
	@go run cmd/web/main.go

## Testing
test:
	@go test ./... -v

test-cover:
	@go test ./... -coverprofile=coverage.out
	@go tool cover -html=coverage.out -o coverage.html

## Clean
clean:
	@rm -rf $(BIN_DIR) coverage.out coverage.html

## Help
help:
	@echo "Available commands:"
	@echo "  build       - Build all binaries"
	@echo "  build-bot   - Build bot only"
	@echo "  build-web   - Build web server only"
	@echo "  run-bot     - Build and run bot"
	@echo "  run-web     - Build and run web server"
	@echo "  dev         - Run bot in development mode"
	@echo "  dev-web     - Run web server in development mode"
	@echo "  test        - Run tests"
	@echo "  clean       - Clean build artifacts"
	@echo "  help        - Show this help"
