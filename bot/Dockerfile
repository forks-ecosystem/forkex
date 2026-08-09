FROM golang:1.25-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /forkex-bot ./cmd/bot

FROM alpine:latest

WORKDIR /root/

COPY --from=build /forkex-bot .

# Устанавливаем зависимости для времени выполнения
RUN apk --no-cache add ca-certificates

# Запускаем приложение
CMD ["./forkex-bot"]
