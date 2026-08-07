package logger

import (
    "log"
    "os"
    "strings"
)

type Logger struct {
    *log.Logger
    level int
}

const (
    LevelDebug = iota
    LevelInfo
    LevelWarn
    LevelError
)

var (
    DefaultLogger *Logger
)

func init() {
    DefaultLogger = New(LevelInfo)
}

func New(level int) *Logger {
    levelStr := os.Getenv("LOG_LEVEL")
    if levelStr != "" {
        switch strings.ToLower(levelStr) {
        case "debug":
            level = LevelDebug
        case "info":
            level = LevelInfo
        case "warn", "warning":
            level = LevelWarn
        case "error":
            level = LevelError
        }
    }
    
    return &Logger{
        Logger: log.New(os.Stdout, "", log.LstdFlags|log.Lshortfile),
        level:  level,
    }
}

func (l *Logger) Debug(format string, v ...interface{}) {
    if l.level <= LevelDebug {
        l.Printf("[DEBUG] "+format, v...)
    }
}

func (l *Logger) Info(format string, v ...interface{}) {
    if l.level <= LevelInfo {
        l.Printf("[INFO] "+format, v...)
    }
}

func (l *Logger) Warn(format string, v ...interface{}) {
    if l.level <= LevelWarn {
        l.Printf("[WARN] "+format, v...)
    }
}

func (l *Logger) Error(format string, v ...interface{}) {
    if l.level <= LevelError {
        l.Printf("[ERROR] "+format, v...)
    }
}

func Debug(format string, v ...interface{}) {
    DefaultLogger.Debug(format, v...)
}

func Info(format string, v ...interface{}) {
    DefaultLogger.Info(format, v...)
}

func Warn(format string, v ...interface{}) {
    DefaultLogger.Warn(format, v...)
}

func Error(format string, v ...interface{}) {
    DefaultLogger.Error(format, v...)
}
