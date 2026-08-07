package conservative_mm

import (
	"log"
	"math"

	"github.com/ixbaseANT/bot/internal/market"
	"github.com/ixbaseANT/bot/internal/market/data"
)

type MarketAnalyzer struct {
	provider data.MarketDataProvider
}

type MarketConditions struct {
	Trend              TrendDirection
	Volatility         float64
	SupportLevels      []float64
	ResistanceLevels   []float64
	OrderBookImbalance float64
	RecommendedSpread  float64
	RecommendedSizes   map[string]float64
}

type TrendDirection string

const (
	TrendUp      TrendDirection = "up"
	TrendDown    TrendDirection = "down"
	TrendSideways TrendDirection = "sideways"
)

func NewMarketAnalyzer(provider data.MarketDataProvider) *MarketAnalyzer {
	return &MarketAnalyzer{
		provider: provider,
	}
}

func (ma *MarketAnalyzer) Analyze(pairID int, symbol string) (*MarketConditions, error) {
	conditions := &MarketConditions{
		RecommendedSizes: make(map[string]float64),
	}

	candles, err := ma.provider.GetCandles(symbol, "5m", 24)
	if err == nil && len(candles) > 0 {
		conditions.Trend = ma.analyzeTrend(candles)
		conditions.Volatility = ma.calculateVolatility(candles)
		conditions.SupportLevels, conditions.ResistanceLevels = ma.findSupportResistance(candles)
	}

	orderBook, err := ma.provider.GetOrderBook(symbol, 20)
	if err == nil && orderBook.Bids != nil {
		conditions.OrderBookImbalance = ma.calculateOrderBookImbalance(&orderBook)
	}

	conditions.RecommendedSpread = ma.calculateRecommendedSpread(conditions)
	conditions.RecommendedSizes = ma.calculateRecommendedSizes(conditions)

	ma.logAnalysis(conditions, &orderBook)
	return conditions, nil
}

func (ma *MarketAnalyzer) analyzeTrend(candles []market.Candle) TrendDirection {
	if len(candles) < 5 {
		return TrendSideways
	}

	upCount := 0
	for i := 1; i <= 5; i++ {
		if candles[len(candles)-i].Close > candles[len(candles)-i-1].Close {
			upCount++
		}
	}

	if upCount >= 4 {
		return TrendUp
	} else if upCount <= 1 {
		return TrendDown
	}

	return TrendSideways
}

func (ma *MarketAnalyzer) calculateVolatility(candles []market.Candle) float64 {
	if len(candles) < 2 {
		return 0.01
	}

	var sum float64
	for i := 1; i < len(candles); i++ {
		returns := math.Abs(candles[i].Close-candles[i-1].Close) / candles[i-1].Close
		sum += returns
	}

	return sum / float64(len(candles)-1)
}

func (ma *MarketAnalyzer) findSupportResistance(candles []market.Candle) ([]float64, []float64) {
	var supports, resistances []float64

	if len(candles) < 10 {
		return supports, resistances
	}

	for i := 2; i < len(candles)-2; i++ {
		if candles[i].Low < candles[i-1].Low &&
			candles[i].Low < candles[i-2].Low &&
			candles[i].Low < candles[i+1].Low &&
			candles[i].Low < candles[i+2].Low {
			supports = append(supports, candles[i].Low)
		}

		if candles[i].High > candles[i-1].High &&
			candles[i].High > candles[i-2].High &&
			candles[i].High > candles[i+1].High &&
			candles[i].High > candles[i+2].High {
			resistances = append(resistances, candles[i].High)
		}
	}

	return supports, resistances
}

func (ma *MarketAnalyzer) calculateOrderBookImbalance(book *market.OrderBook) float64 {
	if book == nil || len(book.Bids) == 0 || len(book.Asks) == 0 {
		return 0
	}

	var bidVolume, askVolume float64

	levels := 5
	for i := 0; i < levels && i < len(book.Bids); i++ {
		bidVolume += book.Bids[i].Quantity
	}
	for i := 0; i < levels && i < len(book.Asks); i++ {
		askVolume += book.Asks[i].Quantity
	}

	totalVolume := bidVolume + askVolume
	if totalVolume == 0 {
		return 0
	}

	return (bidVolume - askVolume) / totalVolume
}

func (ma *MarketAnalyzer) calculateRecommendedSpread(conditions *MarketConditions) float64 {
	baseSpread := 0.001

	volatilityFactor := 1 + conditions.Volatility*10
	if volatilityFactor > 3 {
		volatilityFactor = 3
	}

	return baseSpread * volatilityFactor
}

func (ma *MarketAnalyzer) calculateRecommendedSizes(conditions *MarketConditions) map[string]float64 {
	sizes := make(map[string]float64)

	baseSize := 0.01

	buySize := baseSize
	sellSize := baseSize

	if conditions.OrderBookImbalance > 0.2 {
		buySize *= 0.7
		sellSize *= 1.3
	} else if conditions.OrderBookImbalance < -0.2 {
		buySize *= 1.3
		sellSize *= 0.7
	}

	switch conditions.Trend {
	case TrendUp:
		buySize *= 1.2
		sellSize *= 0.8
	case TrendDown:
		buySize *= 0.8
		sellSize *= 1.2
	}

	sizes["buy"] = buySize
	sizes["sell"] = sellSize

	return sizes
}

func (ma *MarketAnalyzer) logAnalysis(conditions *MarketConditions, book *market.OrderBook) {
	log.Printf("[MarketAnalyzer] ========== АНАЛИЗ РЫНКА ==========")
	log.Printf("[MarketAnalyzer] Тренд: %s", conditions.Trend)
	log.Printf("[MarketAnalyzer] Волатильность: %.2f%%", conditions.Volatility*100)
	log.Printf("[MarketAnalyzer] Дисбаланс стакана: %.2f", conditions.OrderBookImbalance)
	log.Printf("[MarketAnalyzer] Рек. спред: %.3f%%", conditions.RecommendedSpread*100)

	if len(conditions.SupportLevels) > 0 {
		log.Printf("[MarketAnalyzer] Поддержка: %v", conditions.SupportLevels)
	}
	if len(conditions.ResistanceLevels) > 0 {
		log.Printf("[MarketAnalyzer] Сопротивление: %v", conditions.ResistanceLevels)
	}

	if book != nil && len(book.Bids) > 0 && len(book.Asks) > 0 {
		log.Printf("[MarketAnalyzer] Стакан: Bids %.2f @ %.2f | Asks %.2f @ %.2f",
			book.Bids[0].Quantity, book.Bids[0].Price,
			book.Asks[0].Quantity, book.Asks[0].Price)
	}
}
