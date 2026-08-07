package config

import (
    "os"
    "strconv"
    "github.com/joho/godotenv"
)

type Config struct {
    Database DatabaseConfig
    API      APIConfig
    Bot      BotConfig
}

type DatabaseConfig struct {
    DSN string
}

type APIConfig struct {
    Port string `yaml:"port" env:"API_PORT_BOT" env-default:"8082"`
    BaseURL   string
    APIKey    string
    APISecret string
}

type BotConfig struct {
    DefaultUpdateRate int
    MaxConcurrentBots int
    LogLevel          string
}

func Load() (*Config, error) {
    _ = godotenv.Load()
    
    return &Config{
        Database: DatabaseConfig{
            DSN: getEnv("DB_DSN", "postgres://forkex_user:password@localhost:5432/forkex_bot"),
        },
        API: APIConfig{
            BaseURL:   getEnv("API_BASE_URL", "http://forkex-api:10010"),
            APIKey:    getEnv("API_KEY", ""),
            APISecret: getEnv("API_SECRET", ""),
        },
        Bot: BotConfig{
            DefaultUpdateRate: getEnvAsInt("BOT_UPDATE_RATE", 30),
            MaxConcurrentBots: getEnvAsInt("MAX_CONCURRENT_BOTS", 10),
            LogLevel:          getEnv("LOG_LEVEL", "info"),
        },
    }, nil
}

func getEnv(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}

func getEnvAsInt(key string, defaultValue int) int {
    if value := os.Getenv(key); value != "" {
        if intVal, err := strconv.Atoi(value); err == nil {
            return intVal
        }
    }
    return defaultValue
}
