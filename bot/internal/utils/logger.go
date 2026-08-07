package utils

type Logger struct{}

func NewLogger(level string) *Logger {
    return &Logger{}
}

func (l *Logger) Info(msg string, args ...interface{}) {
    println("[INFO]", msg)
}

func (l *Logger) Error(msg string, args ...interface{}) {
    println("[ERROR]", msg)
}

func (l *Logger) Fatal(msg string, args ...interface{}) {
    println("[FATAL]", msg)
    panic(msg)
}

func (l *Logger) Warn(msg string, args ...interface{}) {
    println("[WARN]", msg)
}
