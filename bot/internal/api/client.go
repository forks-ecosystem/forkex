package api

import (
    "github.com/ixbaseANT/bot/internal/config"
)

type Client struct {
    config *config.APIConfig
}

func NewClient(cfg *config.APIConfig) *Client {
    return &Client{config: cfg}
}

func (c *Client) GetMarketPrice(symbol string) (float64, error) {
    // TODO: Реализовать получение цены
    return 100.0, nil
}

func (c *Client) PlaceOrder(symbol, side string, price, size float64) (string, error) {
    // TODO: Реализовать размещение ордера
    return "order_123", nil
}
