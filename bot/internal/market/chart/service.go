package chart import ( "encoding/json" "fmt" "log" "time"
    
    "github.com/ixbaseANT/bot/internal/market" )
// ChartService сервис для работы с графиками
type ChartService struct { provider *market.Provider
}
// NewChartService создает новый сервис графиков
func NewChartService(provider *market.Provider) *ChartService { 
    return &ChartService{provider: provider}
}
// GetChartData получает данные для графика
func (s *ChartService) GetChartData(symbol, timeframe string, 
limit int) (map[string]interface{}, error) {
    // Получаем свечи
    candles, err := s.provider.GetCandles(symbol, timeframe, 
    limit) if err != nil {
        return nil, fmt.Errorf("failed to get candles: %v", err)
    }
    
    // Получаем текущие рыночные данные
    snapshot, err := s.provider.GetMarketSnapshot(symbol) if err 
    != nil {
        log.Printf("Warning: failed to get market snapshot: %v", 
        err)
    }
    
    // Формируем данные для графика
    chartData := map[string]interface{}{ "symbol": symbol, 
        "timeframe": timeframe, "timestamp": time.Now().Unix(), 
        "candles": s.formatCandles(candles), "indicators": 
        snapshot.Indicators, "market_data": 
        map[string]interface{}{
            "current_price": snapshot.CurrentPrice, "bid_price": 
            snapshot.BidPrice, "ask_price": snapshot.AskPrice, 
            "spread": snapshot.Spread, "volume_24h": 
            snapshot.Volume24h, "change_24h": snapshot.Change24h,
        },
    }
    
    // Добавляем данные стакана если есть
    if snapshot.OrderBook != nil { chartData["orderbook"] = 
        s.formatOrderBook(snapshot.OrderBook)
    }
    
    return chartData, nil
}
// formatCandles форматирует свечи для фронтенда
func (s *ChartService) formatCandles(candles []market.Candle) 
[]map[string]interface{} {
    var formatted []map[string]interface{}
    
    for _, candle := range candles { formatted = append(formatted, 
        map[string]interface{}{
            "time": candle.Timestamp.Unix(), "open": candle.Open, 
            "high": candle.High, "low": candle.Low, "close": 
            candle.Close, "volume": candle.Volume,
        })
    }
    
    return formatted
}
// formatOrderBook форматирует стакан для фронтенда
func (s *ChartService) formatOrderBook(ob *market.OrderBook) 
map[string]interface{} {
    var bids, asks []map[string]interface{}
    
    for _, bid := range ob.Bids { bids = append(bids, 
        map[string]interface{}{
            "price": bid.Price, "quantity": bid.Quantity, "total": 
            bid.Price * bid.Quantity,
        })
    }
    
    for _, ask := range ob.Asks { asks = append(asks, 
        map[string]interface{}{
            "price": ask.Price, "quantity": ask.Quantity, "total": 
            ask.Price * ask.Quantity,
        })
    }
    
    return map[string]interface{}{ "timestamp": 
        ob.Timestamp.Unix(), "bids": bids, "asks": asks, "symbol": 
        ob.Symbol,
    }
}
// GetRealTimeUpdates получает обновления в реальном времени
func (s *ChartService) GetRealTimeUpdates(symbol string) (chan 
map[string]interface{}, error) {
    updateChan := make(chan map[string]interface{}, 100)
    
    go func() { ticker := time.NewTicker(1 * time.Second) defer 
        ticker.Stop() defer close(updateChan)
        
        for range ticker.C { snapshot, err := 
            s.provider.GetMarketSnapshot(symbol) if err != nil {
                log.Printf("Error getting snapshot: %v", err) 
                continue
            }
            
            update := map[string]interface{}{ "type": 
                "market_update", "data": map[string]interface{}{
                    "timestamp": snapshot.Timestamp.Unix(), 
                    "price": snapshot.CurrentPrice, "bid": 
                    snapshot.BidPrice, "ask": snapshot.AskPrice, 
                    "spread": snapshot.Spread, "volume": 
                    snapshot.Volume24h, "indicators": 
                    snapshot.Indicators,
                },
            }
            
            select { case updateChan <- update:
                // Отправлено успешно
            default: log.Printf("Update channel full, skipping")
            }
        }
    }()
    
    return updateChan, nil
}
// SaveChartImage сохраняет график как изображение (заглушка)
func (s *ChartService) SaveChartImage(chartData 
map[string]interface{}, filename string) error {
    // Здесь можно интегрировать с библиотекой для генерации 
    // графиков Например: github.com/wcharczuk/go-chart или 
    // gonum.org/v1/plot
    
    data, err := json.MarshalIndent(chartData, "", " ") if err != 
    nil {
        return err
    }
    
    log.Printf("Chart data for %s:\n%s", filename, string(data))
    
    // В реальной реализации здесь будет генерация PNG/SVG
    return nil
}

