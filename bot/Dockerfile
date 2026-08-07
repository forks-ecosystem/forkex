FROM alpine:latest

WORKDIR /root/

# Копируем предварительно собранный бинарник
COPY ./bin/forkex-bot .

# Устанавливаем зависимости для времени выполнения
RUN apk --no-cache add ca-certificates

# Запускаем приложение
CMD ["./forkex-bot"]
