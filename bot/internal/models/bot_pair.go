// internal/models/bot_pair.go
package models

import (
//    "encoding/json"
    "time"
)

type BotPair struct {
    ID              int       `json:"id" db:"id"`
    BotID           int       `json:"bot_id" db:"bot_id"`
    Symbol          string    `json:"symbol" db:"symbol"`
    BaseAsset       string    `json:"base_asset" db:"base_asset"`
    QuoteAsset      string    `json:"quote_asset" db:"quote_asset"`
    
    MinPrice        float64   `json:"min_price" db:"min_price"`
    MaxPrice        float64   `json:"max_price" db:"max_price"`
    GridLevels      int       `json:"grid_levels" db:"grid_levels"`
    GridSpacing     float64   `json:"grid_spacing" db:"grid_spacing"`
    
    MaxPositionSize float64   `json:"max_position_size" db:"max_position_size"`
    MinOrderSize    float64   `json:"min_order_size" db:"min_order_size"`
    MaxOrderSize    float64   `json:"max_order_size" db:"max_order_size"`
    
    IsActive        bool      `json:"is_active" db:"is_active"`
    CreatedAt       time.Time `json:"created_at" db:"created_at"`
    UpdatedAt       time.Time `json:"updated_at" db:"updated_at"`
    
    Settings        JSONB     `json:"settings" db:"settings"`
}

// MarketMakerSettings - настройки маркет-мейкера
type MarketMakerSettings struct {
    Spread     float64 `json:"spread"`      // спред в процентах
    Levels     int     `json:"levels"`      // количество уровней
    OrderSize  float64 `json:"order_size"`  // размер ордера
    MinSpread  float64 `json:"min_spread"`  // минимальный спред
    MaxSpread  float64 `json:"max_spread"`  // максимальный спред
    AutoAdjust bool    `json:"auto_adjust"` // авто-регулировка
}

// GetMarketMakerSettings - получает настройки маркет-мейкера
func (bp *BotPair) GetMarketMakerSettings() MarketMakerSettings {
    var settings MarketMakerSettings
    
    if marketMaker, ok := bp.Settings["market_maker"].(map[string]interface{}); ok {
        if spread, ok := marketMaker["spread"].(float64); ok {
            settings.Spread = spread
        }
        if levels, ok := marketMaker["levels"].(float64); ok {
            settings.Levels = int(levels)
        }
        if orderSize, ok := marketMaker["order_size"].(float64); ok {
            settings.OrderSize = orderSize
        }
        if minSpread, ok := marketMaker["min_spread"].(float64); ok {
            settings.MinSpread = minSpread
        }
        if maxSpread, ok := marketMaker["max_spread"].(float64); ok {
            settings.MaxSpread = maxSpread
        }
        if autoAdjust, ok := marketMaker["auto_adjust"].(bool); ok {
            settings.AutoAdjust = autoAdjust
        }
    }
    
    // Значения по умолчанию
    if settings.Spread == 0 {
        settings.Spread = 0.5 // 0.5%
    }
    if settings.Levels == 0 {
        settings.Levels = 3
    }
    if settings.OrderSize == 0 {
        settings.OrderSize = 0.01
    }
    
    return settings
}

// UpdateMarketMakerSetting - обновляет настройку маркет-мейкера
func (bp *BotPair) UpdateMarketMakerSetting(key string, value interface{}) {
    if bp.Settings == nil {
        bp.Settings = make(JSONB)
    }
    
    marketMaker, ok := bp.Settings["market_maker"].(map[string]interface{})
    if !ok {
        marketMaker = make(map[string]interface{})
    }
    
    marketMaker[key] = value
    bp.Settings["market_maker"] = marketMaker
}

// JSONB - тип для работы с JSON в базе данных
/*
type JSONB map[string]interface{}

func (j JSONB) Value() (interface{}, error) {
    return json.Marshal(j)
}

func (j *JSONB) Scan(value interface{}) error {
    if value == nil {
        *j = JSONB{}
        return nil
    }
    
    data, ok := value.([]byte)
    if !ok {
        data = []byte{}
    }
    
    return json.Unmarshal(data, j)
}
*/
// internal/models/bot_pair.go - дополните существующий тип JSONB
/*
type JSONB map[string]interface{}

func (j JSONB) Value() (driver.Value, error) {
    if j == nil {
        return "{}", nil
    }
    return json.Marshal(j)
}

func (j *JSONB) Scan(value interface{}) error {
    if value == nil {
        *j = JSONB{}
        return nil
    }
    
    var bytes []byte
    switch v := value.(type) {
    case []byte:
        bytes = v
    case string:
        bytes = []byte(v)
    default:
        *j = JSONB{}
        return nil
    }
    
    return json.Unmarshal(bytes, j)
}
*/