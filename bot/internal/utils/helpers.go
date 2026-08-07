package utils

import (
    "math/rand"
    "strconv"
    "time"
//    "fmt"
//    "encoding/json"
)

func init() {
    rand.Seed(time.Now().UnixNano())
}

func GenerateOrderID() string {
    return GenerateUUID()
}

func GenerateUUID() string {
    return "order_" + time.Now().Format("20060102150405") + 
           "_" + RandomString(8)
}

func RandomString(n int) string {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    b := make([]byte, n)
    for i := range b {
        b[i] = letters[rand.Intn(len(letters))]
    }
    return string(b)
}

func FloatToString(value float64) string {
    return strconv.FormatFloat(value, 'f', -1, 64)
}

func StringToFloat(s string) float64 {
    value, _ := strconv.ParseFloat(s, 64)
    return value
}

// Вспомогательные функции

func GetFloat(config map[string]interface{}, key string, defaultValue float64) float64 {
    if value, ok := config[key]; ok {
        switch v := value.(type) {
        case float64:
            return v
        case int:
            return float64(v)
        case float32:
            return float64(v)
        case string:
            if f, err := strconv.ParseFloat(v, 64); err == nil {
                return f
            }
        }
    }
    return defaultValue
}

func GetInt(config map[string]interface{}, key string, defaultValue int) int {
    if value, ok := config[key]; ok {
        switch v := value.(type) {
        case int:
            return v
        case float64:
            return int(v)
        case float32:
            return int(v)
        case string:
            if i, err := strconv.Atoi(v); err == nil {
                return i
            }
        }
    }
    return defaultValue
}

func GetString(config map[string]interface{}, key string, defaultValue string) string {
    if value, ok := config[key]; ok {
        if s, ok := value.(string); ok {
            return s
        }
    }
    return defaultValue
}

func GetBool(config map[string]interface{}, key string, defaultValue bool) bool {
    if value, ok := config[key]; ok {
        if b, ok := value.(bool); ok {
            return b
        }
    }
    return defaultValue
}

// variation возвращает множитель для размера ордера с небольшим случайным отклонением
func Variation(level int) float64 {
    // Чем выше уровень, тем меньше размер ордера
    base := 1.0 / float64(level)
    // Добавляем небольшое случайное отклонение (20%)
    randomFactor := 0.8 + rand.Float64()*0.4
    return base * randomFactor
}
