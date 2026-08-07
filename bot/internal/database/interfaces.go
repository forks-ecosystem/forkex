// internal/database/interfaces.go
package database

import (
    "context"
    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
)

type Querier interface {
    Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
    Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
    QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Pinger interface {
    Ping(ctx context.Context) error
}

type Closer interface {
    Close()
}

type Database interface {
    Querier
    Pinger
    Closer
}

// Если хочешь полную независимость от pgx  определяй свои Rows/Row здесь же
// Но для pgx-проектов большинство оставляет pgx.Rows / pgx.Row  это нормально
